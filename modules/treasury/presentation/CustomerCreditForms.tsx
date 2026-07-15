"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BankAccountDto } from "@/modules/treasury/application/banking";
import type { CustomerCreditDetail } from "@/modules/treasury/application/customerCredits";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

type RefundAction = "approve" | "post" | "cancel";

export function CustomerCreditApplicationForm({ credit }: { credit: CustomerCreditDetail }) {
  const router = useRouter();
  const keyRef = useRef<string | null>(null);
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const [dueDateId, setDueDateId] = useState(credit.eligibleDueDates[0]?.id ?? "");
  const selectedDueDate = credit.eligibleDueDates.find((dueDate) => dueDate.id === dueDateId);
  const defaultAmount = minimumAmount(credit.availableAmount, selectedDueDate?.pendingAmount ?? "0.00");
  const disabled = state.status === "submitting" || credit.status === "HELD" || credit.eligibleDueDates.length === 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setState({ status: "submitting" });
    try {
      keyRef.current ??= crypto.randomUUID();
      const response = await fetch(`/api/treasury/customer-credits/${credit.id}/applications`, {
        method: "POST",
        headers: await mutationHeaders(keyRef.current),
        body: JSON.stringify({
          targetDueDateId: String(data.get("targetDueDateId") ?? ""),
          applicationDate: String(data.get("applicationDate") ?? ""),
          amount: String(data.get("amount") ?? ""),
          notes: optionalText(data.get("notes"))
        })
      });
      const body = await responseBody(response);
      if (!response.ok) {
        if (response.status < 500) keyRef.current = null;
        setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudo compensar el saldo." });
        return;
      }
      keyRef.current = null;
      setState({ status: "success", message: "Saldo compensado. Los importes de la factura y del credito se han actualizado." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Resultado incierto. Reintenta sin recargar para conservar la misma clave idempotente." });
    }
  }

  return (
    <form className="form-grid" onSubmit={submit} aria-busy={state.status === "submitting"}>
      <fieldset disabled={disabled}>
        <legend>Compensar saldo con una factura</legend>
        <p className="muted">La compensacion reduce el saldo a favor y el pendiente del vencimiento; no registra una entrada de dinero.</p>
        <div className="form-three-columns">
          <label>
            Factura y vencimiento
            <select name="targetDueDateId" required value={dueDateId} onChange={(event) => setDueDateId(event.currentTarget.value)}>
              {credit.eligibleDueDates.map((dueDate) => (
                <option key={dueDate.id} value={dueDate.id}>
                  {dueDate.invoiceNumber ?? "Sin numero"} · {formatDate(dueDate.dueDate)} · pendiente {formatMoney(dueDate.pendingAmount)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fecha de compensacion
            <input name="applicationDate" type="date" required min={credit.sourceInvoice.issueDate} defaultValue={today()} />
          </label>
          <label>
            Importe
            <input key={`${dueDateId}-${defaultAmount}`} name="amount" required inputMode="decimal" pattern="[0-9]+([.][0-9]{2})" defaultValue={defaultAmount} aria-describedby="credit-application-limit" />
            <small id="credit-application-limit">Maximo {formatMoney(defaultAmount)} para el vencimiento seleccionado.</small>
          </label>
        </div>
        <label>
          Observaciones internas
          <input name="notes" maxLength={500} />
        </label>
        <label className="checkbox-label">
          <input name="confirmed" type="checkbox" required />
          Confirmo que esta compensacion corresponde al mismo cliente y no representa un cobro bancario.
        </label>
      </fieldset>
      <div className="form-actions">
        <button className="button" type="submit" disabled={disabled}>{state.status === "submitting" ? "Compensando..." : "Compensar saldo"}</button>
        {credit.status === "HELD" ? <p className="message warning">El saldo esta retenido hasta la aceptacion fiscal de la rectificativa.</p> : null}
        {credit.status !== "HELD" && credit.eligibleDueDates.length === 0 ? <p className="muted">El cliente no tiene vencimientos que admitan compensacion.</p> : null}
        <SubmissionMessage state={state} />
      </div>
    </form>
  );
}

export function CustomerCreditRefundRequestForm({ credit, bankAccounts }: { credit: CustomerCreditDetail; bankAccounts: BankAccountDto[] }) {
  const router = useRouter();
  const keyRef = useRef<string | null>(null);
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const availableAccounts = bankAccounts.filter((account) => account.status === "ACTIVE" && account.currency === credit.currency);
  const disabled = state.status === "submitting" || credit.status === "HELD" || Number(credit.availableAmount) <= 0 || availableAccounts.length === 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setState({ status: "submitting" });
    try {
      keyRef.current ??= crypto.randomUUID();
      const response = await fetch(`/api/treasury/customer-credits/${credit.id}/refund-requests`, {
        method: "POST",
        headers: await mutationHeaders(keyRef.current),
        body: JSON.stringify({
          bankAccountId: String(data.get("bankAccountId") ?? ""),
          requestedDate: String(data.get("requestedDate") ?? ""),
          amount: String(data.get("amount") ?? ""),
          reasonCode: String(data.get("reasonCode") ?? ""),
          reference: optionalText(data.get("reference")),
          notes: optionalText(data.get("notes"))
        })
      });
      const body = await responseBody(response);
      if (!response.ok) {
        if (response.status < 500) keyRef.current = null;
        setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudo solicitar el reembolso." });
        return;
      }
      keyRef.current = null;
      setState({ status: "success", message: "Reembolso solicitado. El importe queda reservado hasta su aprobacion o cancelacion." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Resultado incierto. Reintenta sin recargar para conservar la misma clave idempotente." });
    }
  }

  return (
    <form className="form-grid" onSubmit={submit} aria-busy={state.status === "submitting"}>
      <fieldset disabled={disabled}>
        <legend>Solicitar reembolso al cliente</legend>
        <p className="message warning">La solicitud reserva saldo. Tras una aprobacion independiente debera contabilizarse la salida bancaria.</p>
        <div className="form-three-columns">
          <label>
            Cuenta bancaria
            <select name="bankAccountId" required defaultValue={availableAccounts[0]?.id ?? ""}>
              {availableAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.maskedIban}</option>)}
            </select>
          </label>
          <label>
            Fecha solicitada
            <input name="requestedDate" type="date" required min={credit.sourceInvoice.issueDate} defaultValue={today()} />
          </label>
          <label>
            Importe
            <input name="amount" required inputMode="decimal" pattern="[0-9]+([.][0-9]{2})" defaultValue={credit.availableAmount} aria-describedby="credit-refund-limit" />
            <small id="credit-refund-limit">Saldo disponible: {formatMoney(credit.availableAmount)}.</small>
          </label>
        </div>
        <div className="form-three-columns">
          <label>
            Motivo
            <select name="reasonCode" required defaultValue="">
              <option value="" disabled>Selecciona un motivo</option>
              <option value="CUSTOMER_REQUEST">Solicitud del cliente</option>
              <option value="DUPLICATE_OR_EXCESS">Duplicidad o exceso</option>
              <option value="CANCELLATION">Cancelacion de operacion</option>
              <option value="OTHER">Otro</option>
            </select>
          </label>
          <label>Referencia bancaria<input name="reference" maxLength={120} /></label>
          <label>Observaciones internas<input name="notes" maxLength={500} /></label>
        </div>
        <label className="checkbox-label">
          <input name="confirmed" type="checkbox" required />
          Confirmo el importe, la cuenta de salida y que la solicitud requerira aprobacion antes de contabilizarse.
        </label>
      </fieldset>
      <div className="form-actions">
        <button className="button" type="submit" disabled={disabled}>{state.status === "submitting" ? "Solicitando..." : "Solicitar reembolso"}</button>
        {availableAccounts.length === 0 ? <p className="message warning">No hay una cuenta bancaria activa en {credit.currency}.</p> : null}
        <SubmissionMessage state={state} />
      </div>
    </form>
  );
}

export function CustomerCreditRefundActionButton({ refundId, action }: { refundId: string; action: RefundAction }) {
  const router = useRouter();
  const keyRef = useRef<string | null>(null);
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const copy = actionCopy(action);

  async function run() {
    if (!window.confirm(copy.confirmation)) return;
    setState({ status: "submitting" });
    try {
      keyRef.current ??= crypto.randomUUID();
      const response = await fetch(`/api/treasury/customer-credit-refunds/${refundId}/${action}`, {
        method: "POST",
        headers: await mutationHeaders(keyRef.current),
        body: JSON.stringify({})
      });
      const body = await responseBody(response);
      if (!response.ok) {
        if (response.status < 500) keyRef.current = null;
        setState({ status: "error", message: body?.message ?? body?.code ?? copy.error });
        return;
      }
      keyRef.current = null;
      setState({ status: "success", message: copy.success });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Resultado incierto. Reintenta sin recargar para conservar la misma clave idempotente." });
    }
  }

  return (
    <div className="compact-stack">
      <button className={action === "cancel" ? "button button-danger-soft button-small" : "button button-secondary button-small"} type="button" onClick={run} disabled={state.status === "submitting"}>
        {state.status === "submitting" ? copy.progress : copy.label}
      </button>
      <SubmissionMessage state={state} />
    </div>
  );
}

function SubmissionMessage({ state }: { state: SubmissionState }) {
  return state.status === "success" || state.status === "error"
    ? <p className={state.status === "error" ? "message error" : "message"} role={state.status === "error" ? "alert" : "status"}>{state.message}</p>
    : null;
}

async function mutationHeaders(idempotencyKey: string): Promise<Record<string, string>> {
  return { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-CSRF-Token": await fetchCsrfToken() };
}

async function responseBody(response: Response): Promise<{ message?: string; code?: string } | null> {
  return await response.json().catch(() => null) as { message?: string; code?: string } | null;
}

function optionalText(value: FormDataEntryValue | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function actionCopy(action: RefundAction) {
  if (action === "approve") return { label: "Aprobar", progress: "Aprobando...", confirmation: "La solicitud quedara aprobada y lista para contabilizar. ¿Continuar?", success: "Reembolso aprobado.", error: "No se pudo aprobar el reembolso." };
  if (action === "post") return { label: "Contabilizar", progress: "Contabilizando...", confirmation: "Se registrara la salida bancaria y su asiento contable. ¿Continuar?", success: "Reembolso contabilizado.", error: "No se pudo contabilizar el reembolso." };
  return { label: "Cancelar solicitud", progress: "Cancelando...", confirmation: "Se liberara el saldo reservado por esta solicitud. ¿Continuar?", success: "Solicitud cancelada.", error: "No se pudo cancelar la solicitud." };
}

function minimumAmount(first: string, second: string): string {
  return Math.min(Number(first), Number(second)).toFixed(2);
}

function today(): string { return new Date().toISOString().slice(0, 10); }
function formatDate(value: string): string { return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("es-ES"); }
function formatMoney(value: string): string { return `${value} EUR`; }
