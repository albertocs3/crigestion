"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { WaiverEvidenceReplacementDetailDto } from "@/modules/accounting/application/waiverEvidenceReplacements";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type State = { status: "idle" | "submitting" } | { status: "error"; message: string };

export function WaiverEvidenceReplacementReview({ detail }: { detail: WaiverEvidenceReplacementDetailDto }) {
  const router = useRouter(); const [state, setState] = useState<State>({ status: "idle" }); const disabled = state.status === "submitting";
  async function post(action: "approve" | "reject", body: Record<string, unknown>) {
    setState({ status: "submitting" });
    try {
      const csrf = await fetchCsrfToken(); const response = await fetch(`/api/accounting/waiver-evidence-replacements/${encodeURIComponent(detail.id)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-CSRF-Token": csrf }, body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => null) as { message?: string; code?: string } | null;
      if (!response.ok) {
        setState({ status: "error", message: payload?.message ?? payload?.code ?? "No se pudo resolver la propuesta." });
        if (response.status === 409) router.refresh();
        return;
      }
      router.refresh();
    } catch { setState({ status: "error", message: "No se pudo conectar con el servidor." }); }
  }
  const canDecide = detail.eligibility.canApprove;
  return <div className="stack">
    <div><h2>Revisión de sustitución contable</h2><p className="muted">Propuesta v{detail.version}, solicitada por {detail.requestedBy.displayName}.</p></div>
    <div className="data-grid"><div><span className="data-label">Estado</span><strong>{statusLabel(detail.status)}</strong></div><div><span className="data-label">Fecha</span><strong>{formatDate(detail.accountingDate)}</strong></div><div><span className="data-label">Evidencia fuente</span><strong>#{detail.sourceEvidence.sequence} · {detail.sourceEvidence.entryNumber}</strong></div></div>
    <div><span className="data-label">Motivo</span><p>{reasonLabel(detail.reasonCode)} — {detail.reasonDetail}</p></div>
    <section className="stack"><div><h3>Evidencia revertida</h3><p className="muted">{detail.sourceEvidence.entryNumber} · {formatDate(detail.sourceEvidence.accountingDate)} · {detail.sourceEvidence.concept}</p></div>
      <AccountingLinesTable lines={detail.sourceEvidence.lines} /></section>
    <section className="stack"><div><h3>Propuesta de sustitución</h3><p className="muted">{formatDate(detail.accountingDate)} · {detail.concept}</p></div>
      <AccountingLinesTable lines={detail.lines} /></section>
    <p className="cell-detail">Revierte el asiento mediante {detail.reversal.entryNumber}, contabilizado el {formatDate(detail.reversal.accountingDate)}. La aprobación creará exactamente las líneas mostradas.</p>
    {canDecide ? <div className="stack"><div className="form-actions"><button className="button" type="button" disabled={disabled} onClick={() => void post("approve", { expectedVersion: detail.version, expectedProposalDigest: detail.proposalDigest })}>{disabled ? "Procesando..." : "Aprobar y contabilizar"}</button></div>
      <form className="stack" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); void post("reject", { expectedVersion: detail.version, rejectionDetail: data.get("rejectionDetail") }); }}><label>Motivo del rechazo<textarea name="rejectionDetail" required minLength={10} maxLength={500} rows={3} disabled={disabled} /></label><button className="button button-secondary" type="submit" disabled={disabled}>Rechazar propuesta</button></form></div> : null}
    {detail.status === "REQUESTED" && detail.isRequestedByActor ? <p className="message warning">El solicitante no puede aprobar ni rechazar su propia propuesta.</p> : null}
    {detail.eligibility.blockers.filter((blocker) => blocker !== "REQUESTER_CANNOT_APPROVE").map((blocker) => <p key={blocker} className="message warning">{blockerLabel(blocker)}</p>)}
    {state.status === "error" ? <p role="alert" className="message error">{state.message}</p> : null}
  </div>;
}

function statusLabel(value: WaiverEvidenceReplacementDetailDto["status"]): string { return ({ REQUESTED: "Pendiente", COMPLETED: "Aprobada", REJECTED: "Rechazada", CANCELLED: "Cancelada" })[value]; }
function reasonLabel(value: WaiverEvidenceReplacementDetailDto["reasonCode"]): string { return ({ CORRECTED_CLASSIFICATION: "Clasificación corregida", CORRECTED_AMOUNT: "Importe corregido", CORRECTED_DATE: "Fecha corregida", OTHER: "Otro" })[value]; }
function formatDate(value: string): string { return new Intl.DateTimeFormat("es-ES").format(new Date(`${value}T00:00:00.000Z`)); }
function formatMoney(value: string): string { return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(Number(value)); }
function AccountingLinesTable({ lines }: { lines: WaiverEvidenceReplacementDetailDto["lines"] }) {
  const totalDebit = lines.reduce((total, line) => total + Number(line.debit), 0);
  const totalCredit = lines.reduce((total, line) => total + Number(line.credit), 0);
  return <div className="table-wrap"><table><thead><tr><th>Posición</th><th>Cuenta</th><th>Concepto</th><th>Debe</th><th>Haber</th></tr></thead>
    <tbody>{lines.map((line) => <tr key={line.position}><td>{line.position}</td><td><strong>{line.account.code}</strong><span className="cell-detail">{line.account.name}</span></td><td>{line.concept}</td><td>{formatMoney(line.debit)}</td><td>{formatMoney(line.credit)}</td></tr>)}</tbody>
    <tfoot><tr><th colSpan={3}>Totales</th><th>{formatMoney(totalDebit.toFixed(2))}</th><th>{formatMoney(totalCredit.toFixed(2))}</th></tr></tfoot></table></div>;
}
function blockerLabel(value: WaiverEvidenceReplacementDetailDto["eligibility"]["blockers"][number]): string { return ({
  REQUEST_NOT_PENDING: "La propuesta ya no está pendiente.", REQUESTER_CANNOT_APPROVE: "El solicitante no puede aprobar su propuesta.",
  WAIVER_MAKER_CANNOT_APPROVE: "Quien autorizó la condonación no puede aprobar esta propuesta.",
  REVIEW_CLOSER_CANNOT_APPROVE: "Quien cerró la revisión fiscal no puede aprobar esta propuesta.",
  FISCAL_YEAR_NOT_OPEN: "El ejercicio contable ya no está abierto.", ACCOUNT_NOT_POSTABLE: "Alguna cuenta dejó de estar activa o ser imputable.",
  SOURCE_EVIDENCE_SUPERSEDED: "La evidencia ya fue sustituida por otra posterior."
})[value]; }
