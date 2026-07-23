"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { FiscalYearCloseRequestDto } from "@/modules/accounting/application/fiscalYearCloseRequests";
import type { FiscalYearReopenRequestDto } from "@/modules/accounting/application/fiscalYearReopenRequests";

type State = { status: "idle" | "submitting" | "success" | "error"; message?: string };
type ClosePreflight = {
  unbalancedEntryCount: number;
  headerLineMismatchCount: number;
  invalidEntryShapeCount: number;
  invalidLineCount: number;
  crossFiscalYearLineCount: number;
  draftInvoiceCount: number;
  invoiceWithoutEntryCount: number;
  unresolvedVerifactuInvoiceCount: number;
  draftPurchaseCount: number;
  purchaseWithoutEntryCount: number;
  pendingCustomerRefundCount: number;
  pendingSupplierRefundCount: number;
  unsupportedAccountBalanceCount: number;
  resultAccountReady: boolean;
};

export function AccountingFiscalYearCreateForm({ defaultYear }: { defaultYear: number }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/accounting/fiscal-years", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-CSRF-Token": await fetchCsrfToken() },
      body: JSON.stringify({ year: String(data.get("year") ?? "") })
    });
    if (response.ok) { setState({ status: "success", message: "Contabilidad creada con el PGC PYMES." }); router.refresh(); return; }
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    setState({ status: "error", message: body?.message ?? "No se pudo crear la contabilidad." });
  }
  return <form className="form-grid" onSubmit={submit}><fieldset><legend>Crear primera contabilidad</legend><p className="muted">Se creara el ejercicio y se cargara el PGC PYMES con subcuentas operativas.</p><label>Ejercicio<input name="year" type="number" min={2000} max={2100} defaultValue={defaultYear} required /></label></fieldset><div className="form-actions"><button className="button" disabled={state.status === "submitting"} type="submit">{state.status === "submitting" ? "Creando..." : "Crear contabilidad"}</button>{state.message ? <p className={state.status === "error" ? "message error" : "message"}>{state.message}</p> : null}</div></form>;
}

export function AccountingFiscalYearCloseActions({
  fiscalYearId,
  year,
  request,
  actorUserId,
  canRequest,
  canApprove
}: {
  fiscalYearId: string;
  year: number;
  request: FiscalYearCloseRequestDto | null;
  actorUserId: string;
  canRequest: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const idempotencyKey = useRef<string | null>(null);
  async function mutate(action: "request" | "approve" | "cancel") {
    const prompt = action === "request"
      ? `Solicitar el cierre de ${year}? Otra persona debera aprobarlo.`
      : action === "approve"
        ? `Aprobar y ejecutar el cierre de ${year}? Se volvera a validar el ejercicio.`
        : `Cancelar la solicitud de cierre de ${year}?`;
    if (!window.confirm(prompt)) return;
    setState({ status: "submitting" });
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const url = action === "request"
        ? `/api/accounting/fiscal-years/${fiscalYearId}/close-requests`
        : `/api/accounting/fiscal-year-close-requests/${request?.id}/${action}`;
      const response = await fetch(url, { method: "POST", headers: { "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": await fetchCsrfToken() } });
      const body = (await response.json().catch(() => null)) as { message?: string; preflight?: ClosePreflight } | null;
      if (response.ok) {
        idempotencyKey.current = null;
        setState({ status: "success", message: action === "request" ? "Solicitud creada." : action === "approve" ? `Cierre completado. Ejercicio ${year + 1} abierto.` : "Solicitud cancelada." });
        router.refresh();
        return;
      }
      setState({
        status: "error",
        message: body?.preflight
          ? formatClosePreflight(body.preflight)
          : body?.message ?? "No se pudo cerrar el ejercicio."
      });
    } catch {
      setState({
        status: "error",
        message: "Resultado incierto. Reintenta sin cambiar la accion para reutilizar la misma clave idempotente."
      });
    }
  }
  const isRequester = request?.requestedById === actorUserId;
  return <div className="form-actions">
    {!request && canRequest ? <button className="button button-danger-soft" disabled={state.status === "submitting"} onClick={() => mutate("request")} type="button">{state.status === "submitting" ? "Solicitando..." : `Solicitar cierre ${year}`}</button> : null}
    {request ? <span className="muted">Pendiente desde {new Date(request.requestedAt).toLocaleString("es-ES")}</span> : null}
    {request && isRequester && canRequest ? <button className="button button-secondary" disabled={state.status === "submitting"} onClick={() => mutate("cancel")} type="button">Cancelar solicitud</button> : null}
    {request && !isRequester && canApprove ? <button className="button button-danger-soft" disabled={state.status === "submitting"} onClick={() => mutate("approve")} type="button">{state.status === "submitting" ? "Validando..." : "Aprobar y cerrar"}</button> : null}
    {request && isRequester && canApprove ? <span className="message">Debe aprobar otra persona.</span> : null}
    {state.message ? <span className={state.status === "error" ? "message error" : "message"}>{state.message}</span> : null}
  </div>;
}

export function AccountingFiscalYearReopenActions({
  closeRequestId,
  year,
  request,
  actorUserId,
  canRequest,
  canApprove
}: {
  closeRequestId: string;
  year: number;
  request: FiscalYearReopenRequestDto | null;
  actorUserId: string;
  canRequest: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const [reasonCode, setReasonCode] = useState("CLOSE_ERROR");
  const [reason, setReason] = useState("");
  const idempotencyKey = useRef<string | null>(null);

  async function mutate(action: "request" | "approve" | "cancel") {
    const prompt = action === "request"
      ? `Solicitar la anulacion del cierre de ${year}? Otra persona debera aprobarla.`
      : action === "approve"
        ? `Anular el cierre y reabrir ${year}? Se generaran contraasientos y ${year + 1} quedara no operativo.`
        : `Cancelar la solicitud de reapertura de ${year}?`;
    if (!window.confirm(prompt)) return;
    setState({ status: "submitting" });
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const url = action === "request"
        ? `/api/accounting/fiscal-year-close-requests/${closeRequestId}/reopen-requests`
        : `/api/accounting/fiscal-year-reopen-requests/${request?.id}/${action}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...(action === "request" ? { "Content-Type": "application/json" } : {}),
          "Idempotency-Key": idempotencyKey.current,
          "X-CSRF-Token": await fetchCsrfToken()
        },
        ...(action === "request" ? { body: JSON.stringify({ reasonCode, reason }) } : {})
      });
      const body = (await response.json().catch(() => null)) as { message?: string; preflight?: FiscalYearReopenRequestDto["preflight"] } | null;
      if (response.ok) {
        idempotencyKey.current = null;
        setState({
          status: "success",
          message: action === "request"
            ? "Solicitud de reapertura creada."
            : action === "approve"
              ? `Cierre anulado mediante contraasientos. Ejercicio ${year} reabierto y ${year + 1} marcado como no operativo.`
              : "Solicitud de reapertura cancelada."
        });
        router.refresh();
        return;
      }
      setState({
        status: "error",
        message: body?.preflight ? formatReopenPreflight(body.preflight) : body?.message ?? "No se pudo tramitar la reapertura."
      });
    } catch {
      setState({
        status: "error",
        message: "Resultado incierto. Reintenta sin cambiar los datos para reutilizar la misma clave idempotente."
      });
    }
  }

  const isRequester = request?.requestedById === actorUserId;
  return <div className="compact-stack">
    {!request && canRequest ? <>
      <label>Motivo
        <select value={reasonCode} onChange={(event) => { setReasonCode(event.target.value); idempotencyKey.current = null; }}>
          <option value="CLOSE_ERROR">Error en el cierre</option>
          <option value="OMITTED_TRANSACTION">Operacion omitida</option>
          <option value="PREMATURE_CLOSE">Cierre prematuro</option>
          <option value="ACCOUNTING_CORRECTION">Correccion contable</option>
          <option value="OTHER">Otro</option>
        </select>
      </label>
      <label>Justificacion
        <textarea value={reason} minLength={10} maxLength={500} required onChange={(event) => { setReason(event.target.value); idempotencyKey.current = null; }} />
      </label>
      <span className="muted">Entre 10 y 500 caracteres ({reason.length}/500).</span>
      <button className="button button-danger-soft" disabled={state.status === "submitting" || reason.trim().length < 10} onClick={() => mutate("request")} type="button">
        {state.status === "submitting" ? "Solicitando..." : `Solicitar reapertura ${year}`}
      </button>
    </> : null}
    {request ? <details open className="compact-stack">
      <summary>Reapertura pendiente de {year}</summary>
      <span>Solicita: <strong>{request.requestedByName}</strong></span>
      <span>Fecha: {new Date(request.requestedAt).toLocaleString("es-ES")}</span>
      <span>Motivo: {reopenReasonLabel(request.reasonCode)}</span>
      <span>Justificacion: {request.reason}</span>
      <span>Ejercicio afectado: {request.year}; sucesor que quedara no operativo: {request.successorYear}</span>
      <span>Asientos a revertir: {formatOriginalEntries(request.originalEntries)}</span>
      <span>Preflight inicial: {request.preflight.ready ? "sin bloqueos" : formatReopenPreflight(request.preflight)}</span>
      <strong>La aprobacion conservara los originales y generara contraasientos enlazados.</strong>
    </details> : null}
    {!request && !canRequest && canApprove ? <span className="muted">Esperando una solicitud de reapertura de otra persona.</span> : null}
    {request && isRequester && canRequest ? <button className="button button-secondary" disabled={state.status === "submitting"} onClick={() => mutate("cancel")} type="button">Cancelar solicitud</button> : null}
    {request && !isRequester && canApprove ? <button className="button button-danger-soft" disabled={state.status === "submitting"} onClick={() => mutate("approve")} type="button">{state.status === "submitting" ? "Validando..." : "Anular cierre y reabrir"}</button> : null}
    {request && isRequester && canApprove ? <span className="message">Debe aprobar otra persona.</span> : null}
    {state.message ? <span role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "message error" : "message"}>{state.message}</span> : null}
  </div>;
}

function formatClosePreflight(report: ClosePreflight): string {
  const blockers = [
    [report.unbalancedEntryCount, "asientos descuadrados"],
    [report.headerLineMismatchCount, "asientos con totales incoherentes"],
    [report.invalidEntryShapeCount, "asientos con estructura invalida"],
    [report.invalidLineCount, "lineas de diario invalidas"],
    [report.crossFiscalYearLineCount, "lineas vinculadas a otro ejercicio"],
    [report.draftInvoiceCount, "facturas de venta en borrador"],
    [report.invoiceWithoutEntryCount, "facturas de venta sin asiento"],
    [report.unresolvedVerifactuInvoiceCount, "facturas con VeriFactu pendiente"],
    [report.draftPurchaseCount, "compras en borrador"],
    [report.purchaseWithoutEntryCount, "compras sin asiento"],
    [report.pendingCustomerRefundCount, "devoluciones a clientes pendientes"],
    [report.pendingSupplierRefundCount, "devoluciones a proveedores pendientes"],
    [report.unsupportedAccountBalanceCount, "cuentas de grupos 0/8/9 con saldo"]
  ] as const;
  const messages = blockers
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  if (!report.resultAccountReady) messages.push("falta la cuenta 129000000 activa y contabilizable");
  return `Cierre bloqueado: ${messages.join("; ")}.`;
}

function formatReopenPreflight(report: FiscalYearReopenRequestDto["preflight"]): string {
  const blockers = [
    [report.alreadyReopenedCount, "reaperturas ya completadas"],
    [report.successorJournalActivityCount, "asientos posteriores no vinculados al cierre"],
    [report.successorCloseRequestCount, "solicitudes de cierre del ejercicio sucesor"],
    [report.successorChildFiscalYearCount, "ejercicios posteriores"],
    [report.successorUnlinkedAccountCount, "cuentas del sucesor sin origen"],
    [report.successorPlanMismatchCount, "cuentas del sucesor modificadas"],
    [report.successorMissingAccountCount, "cuentas no copiadas al sucesor"],
    [report.successorBusinessActivityCount, "operaciones de negocio en el sucesor"]
  ] as const;
  const messages = blockers.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  if (!report.sourceClosed) messages.push("el ejercicio origen no esta cerrado");
  if (!report.successorOpen) messages.push("el ejercicio sucesor no esta abierto");
  if (!report.successorLinkValid) messages.push("el enlace con el ejercicio sucesor no es valido");
  if (!report.automaticEntryEvidenceValid) messages.push("la evidencia de los asientos automaticos no es valida");
  return `Reapertura bloqueada: ${messages.join("; ")}.`;
}

function reopenReasonLabel(reasonCode: FiscalYearReopenRequestDto["reasonCode"]): string {
  return {
    CLOSE_ERROR: "Error en el cierre",
    OMITTED_TRANSACTION: "Operacion omitida",
    PREMATURE_CLOSE: "Cierre prematuro",
    ACCOUNTING_CORRECTION: "Correccion contable",
    OTHER: "Otro"
  }[reasonCode];
}

function formatOriginalEntries(entries: FiscalYearReopenRequestDto["originalEntries"]): string {
  const references = [
    entries.regularization ? `regularizacion ${entries.regularization.number}` : null,
    entries.closing ? `cierre ${entries.closing.number}` : null,
    entries.opening ? `apertura ${entries.opening.number}` : null
  ].filter((value): value is string => value !== null);
  return references.length ? references.join(", ") : "el cierre no genero asientos automaticos con importe";
}
