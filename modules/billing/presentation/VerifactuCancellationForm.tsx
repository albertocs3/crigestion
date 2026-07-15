"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type State = { status: "idle" | "submitting" | "success" | "error"; message?: string };

export function VerifactuCancellationForm({
  invoiceId,
  invoiceNumber,
  environment
}: {
  invoiceId: string;
  invoiceNumber: string;
  environment: "TEST" | "PRODUCTION";
}) {
  const router = useRouter();
  const keyRef = useRef<string | null>(null);
  const [state, setState] = useState<State>({ status: "idle" });
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const confirmed = confirmation === invoiceNumber;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || !acknowledged) return;
    if (!window.confirm(`Se creará un registro fiscal ANULACION para ${invoiceNumber}. El ALTA original se conservará. ¿Continuar?`)) return;
    if (environment === "PRODUCTION" && !window.confirm("Confirmación de PRODUCCIÓN: el worker enviará la anulación a AEAT. ¿Confirmas la operación fiscal?")) return;
    const data = new FormData(event.currentTarget);
    setState({ status: "submitting" });
    try {
      keyRef.current ??= crypto.randomUUID();
      const response = await fetch(`/api/invoices/${invoiceId}/verifactu-cancellation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": keyRef.current,
          "X-CSRF-Token": await fetchCsrfToken()
        },
        body: JSON.stringify({ reasonCode: String(data.get("reasonCode") ?? "") })
      });
      const body = await response.json().catch(() => null) as { message?: string; code?: string } | null;
      if (!response.ok) {
        if (response.status < 500) keyRef.current = null;
        setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudo preparar la anulación VeriFactu." });
        return;
      }
      keyRef.current = null;
      setState({ status: "success", message: "Anulación preparada. El worker realizará el envío en orden de cadena." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Resultado incierto. Reintenta sin recargar para reutilizar la misma clave idempotente." });
    }
  }

  return <form className="form-grid" onSubmit={submit}>
    <fieldset disabled={state.status === "submitting" || state.status === "success"}>
      <legend>Anulación del registro VeriFactu</legend>
      <p className="muted">Entorno de envío: <strong>{environment}</strong></p>
      <p className="message">Solo debe usarse si la factura se emitió por error. No sustituye una factura rectificativa ni borra la factura o su ALTA.</p>
      <label>Motivo fiscal
        <select name="reasonCode" defaultValue="" required>
          <option disabled value="">Selecciona un motivo</option>
          <option value="ISSUED_BY_MISTAKE">Factura emitida por error</option>
          <option value="DUPLICATE_INVOICE">Factura duplicada</option>
          <option value="WRONG_FISCAL_IDENTITY">Identidad fiscal incorrecta</option>
        </select>
      </label>
      <label>Escribe {invoiceNumber} para confirmar
        <input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </label>
      <label><input checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" /> Entiendo que esta acción solo anula el registro fiscal y no revierte factura, asiento, vencimientos ni cobros.</label>
      <button className="button" disabled={!confirmed || !acknowledged || state.status === "submitting" || state.status === "success"} type="submit">
        {state.status === "submitting" ? "Preparando anulación…" : "Crear registro de anulación"}
      </button>
      {state.message ? <p className={state.status === "error" ? "message error" : "message"} role={state.status === "error" ? "alert" : "status"}>{state.message}</p> : null}
    </fieldset>
  </form>;
}
