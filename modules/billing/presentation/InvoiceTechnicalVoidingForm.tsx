"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeDateInputValue } from "@/modules/billing/presentation/dateInput";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function InvoiceTechnicalVoidingForm({ invoiceId, invoiceNumber, defaultVoidDate }: {
  invoiceId: string;
  invoiceNumber: string;
  defaultVoidDate: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const idempotencyKey = useRef(crypto.randomUUID());
  const disabled = state.status === "submitting" || state.status === "success";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const voidDate = normalizeDateInputValue(formData.get("voidDate"));
    setState({ status: "submitting" });

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(`/api/invoices/${invoiceId}/technical-voiding`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          voidDate,
          reasonCode: "ISSUED_BY_MISTAKE",
          confirmation: "VOID_AFTER_ACCEPTED_VERIFACTU_CANCELLATION"
        })
      });

      if (response.ok) {
        setState({ status: "success", message: `La anulacion tecnica de ${invoiceNumber} se ha finalizado.` });
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (response.status >= 400 && response.status < 500) idempotencyKey.current = crypto.randomUUID();
      setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudo finalizar la anulacion tecnica." });
    } catch {
      setState({ status: "error", message: "No se pudo confirmar el resultado. Reintente sin cambiar los datos para recuperar la operacion." });
    }
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset disabled={disabled}>
        <legend>Finalizar anulacion tecnica</legend>
        <p className="message warning">
          Esta accion solo corresponde a una factura emitida por error. Conservara {invoiceNumber}, el ALTA y la ANULACION,
          creara un contraasiento y cancelara sus vencimientos. No crea una rectificativa.
        </p>
        <div className="form-two-columns">
          <label>
            Fecha del contraasiento
            <input aria-describedby="technical-voiding-date-help" name="voidDate" required type="date" min={defaultVoidDate} defaultValue={defaultVoidDate} />
            <small id="technical-voiding-date-help">No puede ser anterior a la fecha de emision y debe pertenecer al ejercicio abierto.</small>
          </label>
          <label className="checkbox-label">
            <input name="confirmed" required type="checkbox" />
            Confirmo que la factura y su ALTA se emitieron por error y que no existio una operacion real que deba rectificarse.
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="button button-danger-soft" disabled={disabled} type="submit">
          {state.status === "submitting" ? "Finalizando..." : `Finalizar anulacion tecnica ${invoiceNumber}`}
        </button>
        {state.status === "error" ? <p className="message error" role="alert">{state.message}</p> : null}
        {state.status === "success" ? <p className="message success" role="status">{state.message}</p> : null}
      </div>
    </form>
  );
}
