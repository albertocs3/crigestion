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
  isCompletedByActor: boolean;
  accountingEvidenceReversal: {
    id: string;
    status: "REQUESTED" | "COMPLETED" | "REJECTED" | "CANCELLED";
    version: number;
    requestedAt: string;
    isRequestedByActor: boolean;
  } | null;
};

export function SubscriptionRenewalWaiverFiscalReviewActions({ review, canDecide, canComplete, canRequestEvidenceReversal, canApproveEvidenceReversal }: {
  review: Review; canDecide: boolean; canComplete: boolean; canRequestEvidenceReversal: boolean; canApproveEvidenceReversal: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [decision, setDecision] = useState("NO_ADDITIONAL_ACTION");
  async function mutate(action: "start" | "decide" | "complete", body: Record<string, unknown>) {
    return post(`/api/subscriptions/renewal-waiver-fiscal-reviews/${review.id}/${action}`, body);
  }
  async function post(url: string, body: Record<string, unknown>) {
    setBusy(true); setMessage(null);
    try {
      const csrf = await fetchCsrfToken();
      const response = await fetch(url, {
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
  if (review.status === "CLOSED" && review.decision === "MANUAL_ACCOUNTING_ACTION_REQUIRED" && review.hasLinkedAccountingEntry) {
    const reversal = review.accountingEvidenceReversal;
    if (reversal?.status === "COMPLETED") return <span className="cell-detail">La evidencia original permanece histórica y está revertida.</span>;
    if (reversal?.status === "REQUESTED") return <div className="stack">
      <span className="cell-detail">Reversión solicitada el {new Date(reversal.requestedAt).toLocaleDateString("es-ES")}.</span>
      {canRequestEvidenceReversal && reversal.isRequestedByActor ? <button className="button button-secondary" type="button" disabled={busy}
        onClick={() => void post(`/api/accounting/waiver-evidence-reversals/${reversal.id}/cancel`, { expectedVersion: reversal.version })}>{busy ? "Cancelando..." : "Cancelar solicitud"}</button> : null}
      {canApproveEvidenceReversal && !reversal.isRequestedByActor && !review.isOwnWaiver && !review.isCompletedByActor ? <button className="button" type="button" disabled={busy}
        onClick={() => void post(`/api/accounting/waiver-evidence-reversals/${reversal.id}/approve`, { expectedVersion: reversal.version })}>{busy ? "Aprobando..." : "Aprobar reversión exacta"}</button> : null}
      {canApproveEvidenceReversal && !reversal.isRequestedByActor ? <form className="stack" onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void post(`/api/accounting/waiver-evidence-reversals/${reversal.id}/reject`, { expectedVersion: reversal.version, rejectionDetail: data.get("rejectionDetail") });
      }}><label>Motivo del rechazo<textarea name="rejectionDetail" required minLength={10} maxLength={500} rows={2} disabled={busy} /></label>
        <button className="button button-secondary" type="submit" disabled={busy}>Rechazar solicitud</button></form> : null}
      {message ? <span role="status" className="cell-detail">{message}</span> : null}
    </div>;
    if (canRequestEvidenceReversal && !review.isOwnWaiver && !review.isCompletedByActor) return <form className="stack" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      void post(`/api/subscriptions/renewal-waiver-fiscal-reviews/${review.id}/accounting-reversals`, {
        expectedReviewVersion: 4, reasonCode: data.get("reversalReasonCode"), reasonDetail: data.get("reversalReasonDetail"), accountingDate: data.get("reversalAccountingDate")
      });
    }}>
      <strong>Solicitar reversión de la evidencia</strong>
      <label>Fecha contable<input name="reversalAccountingDate" type="date" required disabled={busy} /></label>
      <label>Motivo<select name="reversalReasonCode" disabled={busy}><option value="ACCOUNTING_ERROR">Error contable</option><option value="INCORRECT_CLASSIFICATION">Clasificación incorrecta</option><option value="DUPLICATE_REGULARIZATION">Regularización duplicada</option><option value="OTHER">Otro</option></select></label>
      <label>Fundamento<textarea name="reversalReasonDetail" required minLength={10} maxLength={500} rows={3} disabled={busy} /></label>
      <button className="button button-secondary" type="submit" disabled={busy}>{busy ? "Solicitando..." : "Solicitar reversión"}</button>
      <span className="cell-detail">No modifica ni elimina el asiento o la evidencia originales.</span>
      {message ? <span role="status" className="cell-detail">{message}</span> : null}
    </form>;
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
