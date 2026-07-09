"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { CustomerDueDateListItem } from "@/modules/treasury/application/dueDates";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerRemittanceDraftCreateForm({
  dueDates
}: {
  dueDates: CustomerDueDateListItem[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const [selectedDueDateIds, setSelectedDueDateIds] = useState<string[]>(
    dueDates[0] ? [dueDates[0].id] : []
  );
  const disabled = state.status === "submitting" || dueDates.length === 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const formData = new FormData(event.currentTarget);
    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/treasury/customer-remittances", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        chargeDate: String(formData.get("chargeDate") ?? ""),
        concept: String(formData.get("concept") ?? ""),
        dueDateIds: selectedDueDateIds
      })
    });

    if (response.ok) {
      setState({ status: "success", message: "Remesa creada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo crear la remesa."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Nueva remesa</legend>
        <div className="form-two-columns">
          <label>
            Fecha de cargo
            <input
              name="chargeDate"
              type="date"
              required
              defaultValue={new Date().toISOString().slice(0, 10)}
              disabled={disabled}
            />
          </label>
          <label>
            Concepto
            <input
              name="concept"
              required
              maxLength={140}
              defaultValue="Remesa de cobro"
              disabled={disabled}
            />
          </label>
        </div>
        <div className="checkbox-grid compact-stack" role="group" aria-label="Vencimientos remesables">
          {dueDates.map((dueDate) => (
            <label className="checkbox-label" key={dueDate.id}>
              <input
                type="checkbox"
                checked={selectedDueDateIds.includes(dueDate.id)}
                disabled={disabled}
                onChange={(event) => {
                  setSelectedDueDateIds((current) =>
                    event.currentTarget.checked
                      ? [...current, dueDate.id]
                      : current.filter((id) => id !== dueDate.id)
                  );
                }}
              />
              <span>
                {dueDate.invoiceNumber ?? "Sin numero"} - {dueDate.customer.legalName}
                <small>
                  {formatDate(dueDate.dueDate)} - {formatMoney(dueDate.pendingAmount)}
                </small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-actions">
        <button
          className="button"
          disabled={disabled || selectedDueDateIds.length === 0}
          type="submit"
        >
          {state.status === "submitting" ? "Creando..." : "Crear remesa"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
        {dueDates.length === 0 ? (
          <p className="muted">No hay vencimientos domiciliados pendientes.</p>
        ) : null}
      </div>
    </form>
  );
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("es-ES");
}

function formatMoney(value: string): string {
  return `${value} EUR`;
}
