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

export function CustomerPaymentRegisterForm({
  invoiceId,
  dueDates
}: {
  invoiceId: string;
  dueDates: DueDateOption[];
}) {
  const router = useRouter();
  const payableDueDates = dueDates.filter(
    (dueDate) =>
      dueDate.status !== "PAID" &&
      dueDate.status !== "RETURNED" &&
      Number(dueDate.pendingAmount) > 0
  );
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const [selectedDueDateId, setSelectedDueDateId] = useState(
    payableDueDates[0]?.id ?? ""
  );
  const [paymentDate, setPaymentDate] = useState(todayDateInput());
  const [amount, setAmount] = useState(payableDueDates[0]?.pendingAmount ?? "0.00");
  const disabled = payableDueDates.length === 0 || state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(
        paymentPayload(new FormData(form), {
          dueDateId: selectedDueDateId,
          paymentDate,
          amount
        })
      )
    });

    if (response.ok) {
      setState({ status: "success", message: "Cobro registrado." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo registrar el cobro."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Registrar cobro</legend>
        <div className="form-three-columns">
          <label>
            Vencimiento
            <select
              name="dueDateId"
              required
              value={selectedDueDateId}
              disabled={disabled}
              onChange={(event) => {
                const dueDateId = event.currentTarget.value;
                const nextDueDate = payableDueDates.find(
                  (dueDate) => dueDate.id === dueDateId
                );

                setSelectedDueDateId(dueDateId);
                setAmount(nextDueDate?.pendingAmount ?? "0.00");
              }}
            >
              {payableDueDates.map((dueDate) => (
                <option key={dueDate.id} value={dueDate.id}>
                  {formatDate(dueDate.dueDate)} - pendiente {formatMoney(dueDate.pendingAmount)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fecha de cobro
            <input
              name="paymentDate"
              required
              type="date"
              value={paymentDate}
              onChange={(event) => setPaymentDate(event.currentTarget.value)}
              disabled={disabled}
            />
          </label>
          <label>
            Importe cobrado
            <input
              name="amount"
              required
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
              value={amount}
              onChange={(event) => setAmount(event.currentTarget.value)}
              disabled={disabled}
            />
          </label>
        </div>
        <div className="form-two-columns">
          <label>
            Referencia
            <input name="reference" maxLength={120} disabled={disabled} />
          </label>
          <label>
            Observaciones internas
            <input name="notes" maxLength={500} disabled={disabled} />
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="button" disabled={disabled} type="submit">
          {state.status === "submitting" ? "Registrando..." : "Registrar cobro"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
        {payableDueDates.length === 0 ? (
          <p className="muted">No hay vencimientos pendientes de cobro.</p>
        ) : null}
      </div>
    </form>
  );
}

function paymentPayload(
  formData: FormData,
  controlled: {
    dueDateId: string;
    paymentDate: string;
    amount: string;
  }
) {
  return {
    dueDateId: controlled.dueDateId,
    paymentDate: controlled.paymentDate,
    amount: controlled.amount,
    reference: optionalString(formData.get("reference")),
    notes: optionalString(formData.get("notes"))
  };
}

function optionalString(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();

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
