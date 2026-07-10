"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type BankResponseLine = {
  id: string;
  position: number;
  invoiceNumber: string | null;
  customerName: string;
  amount: string;
};

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerRemittanceBankResponseForm({
  remittanceId,
  defaultPaymentDate,
  lines
}: {
  remittanceId: string;
  defaultPaymentDate: string;
  lines: BankResponseLine[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const disabled = state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const formData = new FormData(event.currentTarget);
    const paidLineIds: string[] = [];
    const rejectedLineIds: string[] = [];

    for (const line of lines) {
      const value = String(formData.get(`line-${line.id}`) ?? "");

      if (value === "PAID") {
        paidLineIds.push(line.id);
      }

      if (value === "REJECTED") {
        rejectedLineIds.push(line.id);
      }
    }

    const csrfToken = await fetchCsrfToken();
    const response = await fetch(
      `/api/treasury/customer-remittances/${remittanceId}/settle-bank-response`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          paymentDate: String(formData.get("paymentDate") ?? ""),
          paidLineIds,
          rejectedLineIds,
          rejectionReason: optionalString(formData.get("rejectionReason"))
        })
      }
    );

    if (response.ok) {
      setState({ status: "success", message: "Respuesta bancaria registrada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message:
        body?.message ?? body?.code ?? "No se pudo registrar la respuesta bancaria."
    });
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <div className="filter-row">
        <label>
          Fecha respuesta
          <input
            name="paymentDate"
            type="date"
            required
            defaultValue={defaultPaymentDate}
            disabled={disabled}
          />
        </label>
        <label>
          Motivo incidencias
          <input name="rejectionReason" maxLength={500} disabled={disabled} />
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Linea</th>
              <th>Factura</th>
              <th>Cliente</th>
              <th>Importe</th>
              <th>Respuesta</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.position}</td>
                <td>{line.invoiceNumber ?? "Sin numero"}</td>
                <td>{line.customerName}</td>
                <td>{formatMoney(line.amount)}</td>
                <td>
                  <div className="button-row">
                    <label>
                      <input
                        type="radio"
                        name={`line-${line.id}`}
                        value="PAID"
                        required
                        disabled={disabled}
                      />
                      Cobrada
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`line-${line.id}`}
                        value="REJECTED"
                        required
                        disabled={disabled}
                      />
                      Rechazada
                    </label>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <button className="button button-small" disabled={disabled} type="submit">
          {state.status === "submitting" ? "Registrando..." : "Registrar respuesta"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <span className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function optionalString(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : undefined;
}

function formatMoney(value: string): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR"
  }).format(Number(value));
}
