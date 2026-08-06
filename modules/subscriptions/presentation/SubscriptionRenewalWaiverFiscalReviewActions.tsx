"use client";

import { useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Review = {
  id: string;
  status: "PENDING" | "IN_REVIEW" | "ESCALATED" | "ACTION_REQUIRED" | "CLOSED";
  version: number;
  decision: "NO_ADDITIONAL_ACTION" | "MANUAL_ACCOUNTING_ACTION_REQUIRED" | "BILLING_REGULARIZATION_REQUIRED" | "EXTERNAL_FISCAL_ACTION_REQUIRED" | "EXTERNAL_ADVICE_REQUIRED" | null;
  evidenceCount: number;
  hasLinkedAccountingEntry: boolean;
  isOwnWaiver: boolean;
  isAssignedToActor: boolean;
};

export function SubscriptionRenewalWaiverFiscalReviewActions({ review, canDecide, canComplete }: { review: Review; canDecide: boolean; canComplete: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [decision, setDecision] = useState("NO_ADDITIONAL_ACTION");
  async function mutate(action: "start" | "decide" | "complete", body: Record<string, unknown>) {
    setBusy(true); setMessage(null);
    try {
      const csrf = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/renewal-waiver-fiscal-reviews/${review.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => null) as { message?: string; code?: string } | null;
      if (!response.ok) { setMessage(payload?.message ?? payload?.code ?? "No se pudo actualizar la revisión."); return; }
      window.location.reload();
    } catch { setMessage("No se pudo conectar con el servidor."); }
    finally { setBusy(false); }
  }
  if (review.isOwnWaiver) return <span className="cell-detail">Requiere un revisor distinto de quien condonó.</span>;
  if (review.status === "PENDING" && canDecide) return <div className="stack">
    <button className="button button-secondary" type="button" disabled={busy} onClick={() => void mutate("start", { expectedVersion: 1 })}>{busy ? "Asignando..." : "Asumir revisión"}</button>
    {message ? <span className="cell-detail" role="status">{message}</span> : null}
  </div>;
  if (review.status === "ACTION_REQUIRED" && review.decision === "MANUAL_ACCOUNTING_ACTION_REQUIRED" && review.isAssignedToActor && canComplete) {
    if (!review.hasLinkedAccountingEntry) return <div className="stack">
      <a className="button button-secondary" href={`/app/accounting?waiverReviewId=${encodeURIComponent(review.id)}`}>Crear asiento vinculado</a>
      <span className="cell-detail">El asiento se crea en Contabilidad; esta revisión no genera apuntes automáticamente.</span>
    </div>;
    return <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void mutate("complete", { expectedVersion: 3, detail: data.get("completionDetail") });
    }}>
      <label>Comprobación del cierre<textarea name="completionDetail" required minLength={10} maxLength={500} rows={3} disabled={busy} /></label>
      <button className="button" type="submit" disabled={busy}>{busy ? "Cerrando..." : "Acreditar asiento y cerrar"}</button>
      {message ? <span role="status" className="cell-detail">{message}</span> : null}
    </form>;
  }
  if (!canDecide || review.status !== "IN_REVIEW" || !review.isAssignedToActor) return null;
  const needsDueDate = decision !== "NO_ADDITIONAL_ACTION";
  return <form className="stack" onSubmit={(event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutate("decide", {
      expectedVersion: 2, decision, detail: data.get("detail"),
      ...(needsDueDate ? { actionDueDate: data.get("actionDueDate") } : {})
    });
  }}>
    <label>Conclusión<select value={decision} onChange={(event) => setDecision(event.target.value)} disabled={busy}>
      <option value="NO_ADDITIONAL_ACTION">Sin actuación adicional</option>
      <option value="MANUAL_ACCOUNTING_ACTION_REQUIRED">Actuación contable manual</option>
      <option value="BILLING_REGULARIZATION_REQUIRED">Regularización de facturación</option>
      <option value="EXTERNAL_FISCAL_ACTION_REQUIRED">Actuación fiscal externa</option>
      <option value="EXTERNAL_ADVICE_REQUIRED">Asesoramiento externo</option>
    </select></label>
    <label>Fundamento<textarea name="detail" required minLength={10} maxLength={500} rows={3} disabled={busy} /></label>
    {needsDueDate ? <label>Vencimiento<input name="actionDueDate" type="date" required disabled={busy} /></label> : null}
    <button className="button" type="submit" disabled={busy}>{busy ? "Guardando..." : "Registrar conclusión"}</button>
    {message ? <span role="status" className="cell-detail">{message}</span> : null}
  </form>;
}
