"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerRemittancePaymentReturnForm({
  invoiceId,
  paymentId,
  defaultAmount
}: {
  invoiceId: string;
  paymentId: string;
  defaultAmount: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const [returnDate, setReturnDate] = useState(todayDateInput());
  const [amount, setAmount] = useState(defaultAmount);
  const [reasonCode, setReasonCode] = useState("BANK_RETURN");
  const [notes, setNotes] = useState("");
  const disabled = state.status === "submitting";

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
      body: JSON.stringify({
        paymentId,
        returnDate,
        amount,
        reasonCode: optionalText(reasonCode),
        notes: optionalText(notes)
      })
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
    <form className="compact-stack" onSubmit={handleSubmit}>
      <label>
        Fecha devolucion
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
        Importe
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
      <button className="button button-secondary button-small" disabled={disabled} type="submit">
        {state.status === "submitting" ? "Registrando..." : "Registrar devolucion"}
      </button>
      {state.status === "success" || state.status === "error" ? (
        <span className={state.status === "error" ? "message error" : "message"}>
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

function optionalText(value: string): string | null {
  const text = value.trim();

  return text ? text : null;
}

function todayDateInput(): string {
  return new Date().toISOString().slice(0, 10);
}
