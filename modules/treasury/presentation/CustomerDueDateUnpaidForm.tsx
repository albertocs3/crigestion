"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { InvoiceDetail } from "@/modules/billing/application/invoices";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type DueDateOption = InvoiceDetail["dueDates"][number];

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerDueDateUnpaidForm({
  invoiceId,
  dueDates
}: {
  invoiceId: string;
  dueDates: DueDateOption[];
}) {
  const router = useRouter();
  const unpaidableDueDates = dueDates.filter(
    (dueDate) => dueDate.status === "PENDING" && Number(dueDate.pendingAmount) > 0
  );
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const [selectedDueDateId, setSelectedDueDateId] = useState(
    unpaidableDueDates[0]?.id ?? ""
  );
  const [unpaidDate, setUnpaidDate] = useState(todayDateInput());
  const [reasonCode, setReasonCode] = useState("");
  const [notes, setNotes] = useState("");
  const disabled = unpaidableDueDates.length === 0 || state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/invoices/${invoiceId}/unpaid-due-dates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(
        unpaidPayload({
          dueDateId: selectedDueDateId,
          unpaidDate,
          reasonCode,
          notes
        })
      )
    });

    if (response.ok) {
      setState({ status: "success", message: "Impago registrado." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo registrar el impago."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Registrar impago</legend>
        <div className="form-three-columns">
          <label>
            Vencimiento
            <select
              name="dueDateId"
              required
              value={selectedDueDateId}
              disabled={disabled}
              onChange={(event) => setSelectedDueDateId(event.currentTarget.value)}
            >
              {unpaidableDueDates.map((dueDate) => (
                <option key={dueDate.id} value={dueDate.id}>
                  {formatDate(dueDate.dueDate)} - pendiente {formatMoney(dueDate.pendingAmount)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fecha de impago
            <input
              name="unpaidDate"
              required
              type="date"
              value={unpaidDate}
              onChange={(event) => setUnpaidDate(event.currentTarget.value)}
              disabled={disabled}
            />
          </label>
          <label>
            Motivo
            <input
              name="reasonCode"
              maxLength={80}
              value={reasonCode}
              onChange={(event) => setReasonCode(event.currentTarget.value)}
              disabled={disabled}
            />
          </label>
        </div>
        <label>
          Observaciones internas
          <input
            name="notes"
            maxLength={500}
            value={notes}
            onChange={(event) => setNotes(event.currentTarget.value)}
            disabled={disabled}
          />
        </label>
      </fieldset>
      <div className="form-actions">
        <button className="button button-secondary" disabled={disabled} type="submit">
          {state.status === "submitting" ? "Registrando..." : "Marcar impagado"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
        {unpaidableDueDates.length === 0 ? (
          <p className="muted">No hay vencimientos pendientes para marcar impagados.</p>
        ) : null}
      </div>
    </form>
  );
}

function unpaidPayload(controlled: {
  dueDateId: string;
  unpaidDate: string;
  reasonCode: string;
  notes: string;
}) {
  return {
    dueDateId: controlled.dueDateId,
    unpaidDate: controlled.unpaidDate,
    reasonCode: optionalText(controlled.reasonCode),
    notes: optionalText(controlled.notes)
  };
}

function optionalText(value: string): string | null {
  const text = value.trim();

  return text ? text : null;
}

function todayDateInput(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("es-ES");
}

function formatMoney(value: string): string {
  return `${value} EUR`;
}
