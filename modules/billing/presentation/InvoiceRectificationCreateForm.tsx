"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeDateInputValue } from "@/modules/billing/presentation/dateInput";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string };

export function InvoiceRectificationCreateForm({
  invoiceId,
  defaultIssueDate
}: {
  invoiceId: string;
  defaultIssueDate: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const idempotencyKey = useRef(crypto.randomUUID());
  const disabled = state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);
    const issueDate = normalizeDateInputValue(formData.get("issueDate"));
    const reason = String(formData.get("reason") ?? "OTHER");
    const notes = optionalText(String(formData.get("notes") ?? ""));

    setState({ status: "submitting" });

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(`/api/invoices/${invoiceId}/rectifications`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({ issueDate, reason, fiscalClassification: "R4_OTHER", notes })
      });
      if (response.ok) {
        const body = (await response.json()) as { id: string };
        router.push(`/app/invoices/${body.id}`);
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (response.status >= 400 && response.status < 500) idempotencyKey.current = crypto.randomUUID();
      setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudo crear la rectificativa." });
    } catch {
      setState({ status: "error", message: "No se pudo confirmar el resultado. Reintente sin cambiar los datos." });
    }
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Crear rectificativa</legend>
        <p className="muted">Clasificacion fiscal VeriFactu: R4 por diferencias. No utilice este flujo para insolvencias o impagos.</p>
        <div className="form-three-columns">
          <label>
            Fecha de emision
            <input
              name="issueDate"
              required
              type="date"
              defaultValue={defaultIssueDate}
              disabled={disabled}
            />
          </label>
          <label>
            Motivo
            <select name="reason" defaultValue="OTHER" disabled={disabled}>
              <option value="DATA_ERROR">Error en datos</option>
              <option value="AMOUNT_ERROR">Error en importes</option>
              <option value="RETURN">Devolucion</option>
              <option value="LATE_DISCOUNT">Descuento posterior</option>
              <option value="OPERATION_CANCELLED">Anulacion de operacion</option>
              <option value="UNPAID">Impago</option>
              <option value="OTHER">Otro</option>
            </select>
          </label>
          <label>
            Observaciones internas
            <input name="notes" maxLength={1000} disabled={disabled} />
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="button button-secondary" disabled={disabled} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear rectificativa"}
        </button>
        {state.status === "error" ? (
          <p className="message error">{state.message}</p>
        ) : null}
      </div>
    </form>
  );
}

function optionalText(value: string): string | null {
  const text = value.trim();

  return text ? text : null;
}
