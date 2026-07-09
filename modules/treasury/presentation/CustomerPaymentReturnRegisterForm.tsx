"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { InvoiceDetail } from "@/modules/billing/application/invoices";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type PaymentOption = InvoiceDetail["payments"][number];

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerPaymentReturnRegisterForm({
  invoiceId,
  payments
}: {
  invoiceId: string;
  payments: PaymentOption[];
}) {
  const router = useRouter();
  const returnablePayments = payments.filter((payment) => Number(payment.netAmount) > 0);
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const [selectedPaymentId, setSelectedPaymentId] = useState(
    returnablePayments[0]?.id ?? ""
  );
  const [returnDate, setReturnDate] = useState(todayDateInput());
  const [amount, setAmount] = useState(returnablePayments[0]?.netAmount ?? "0.00");
  const [reasonCode, setReasonCode] = useState("");
  const [notes, setNotes] = useState("");
  const disabled = returnablePayments.length === 0 || state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/invoices/${invoiceId}/payment-returns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(
        paymentReturnPayload({
          paymentId: selectedPaymentId,
          returnDate,
          amount,
          reasonCode,
          notes
        })
      )
    });

    if (response.ok) {
      setState({ status: "success", message: "Devolucion registrada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo registrar la devolucion."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Registrar devolucion</legend>
        <div className="form-three-columns">
          <label>
            Cobro
            <select
              name="paymentId"
              required
              value={selectedPaymentId}
              disabled={disabled}
              onChange={(event) => {
                const paymentId = event.currentTarget.value;
                const nextPayment = returnablePayments.find(
                  (payment) => payment.id === paymentId
                );

                setSelectedPaymentId(paymentId);
                setAmount(nextPayment?.netAmount ?? "0.00");
              }}
            >
              {returnablePayments.map((payment) => (
                <option key={payment.id} value={payment.id}>
                  {formatDate(payment.paymentDate)} - disponible {formatMoney(payment.netAmount)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fecha de devolucion
            <input
              name="returnDate"
              required
              type="date"
              value={returnDate}
              onChange={(event) => setReturnDate(event.currentTarget.value)}
              disabled={disabled}
            />
          </label>
          <label>
            Importe devuelto
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
            Motivo
            <input
              name="reasonCode"
              maxLength={80}
              value={reasonCode}
              onChange={(event) => setReasonCode(event.currentTarget.value)}
              disabled={disabled}
            />
          </label>
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
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="button secondary" disabled={disabled} type="submit">
          {state.status === "submitting" ? "Registrando..." : "Registrar devolucion"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
        {returnablePayments.length === 0 ? (
          <p className="muted">No hay cobros con saldo disponible para devolver.</p>
        ) : null}
      </div>
    </form>
  );
}

function paymentReturnPayload(controlled: {
  paymentId: string;
  returnDate: string;
  amount: string;
  reasonCode: string;
  notes: string;
}) {
  return {
    paymentId: controlled.paymentId,
    returnDate: controlled.returnDate,
    amount: controlled.amount,
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
