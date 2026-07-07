"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { CustomerListItem } from "@/modules/customers/application/customers";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string };

export function InvoiceDraftCreateForm({
  customers
}: {
  customers: CustomerListItem[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const today = new Date().toISOString().slice(0, 10);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/invoices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(invoiceDraftPayload(new FormData(form)))
    });

    if (response.ok) {
      const body = (await response.json()) as { id: string };
      router.push(`/app/invoices/${body.id}`);
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo crear el borrador."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Nuevo borrador</legend>
        <div className="form-three-columns">
          <label>
            Cliente
            <select name="customerId" required disabled={customers.length === 0}>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.code} - {customer.legalName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fecha de emision
            <input name="issueDate" required type="date" defaultValue={today} />
          </label>
          <label>
            Fecha de operacion
            <input name="operationDate" required type="date" defaultValue={today} />
          </label>
        </div>
        <label>
          Notas internas
          <textarea name="notes" maxLength={1000} rows={3} />
        </label>
      </fieldset>
      <div className="form-actions">
        <button
          className="button"
          disabled={state.status === "submitting" || customers.length === 0}
          type="submit"
        >
          {state.status === "submitting" ? "Creando..." : "Crear borrador"}
        </button>
        {state.status === "error" ? (
          <p className="message error">{state.message}</p>
        ) : null}
      </div>
    </form>
  );
}

function invoiceDraftPayload(formData: FormData) {
  return {
    customerId: String(formData.get("customerId") ?? ""),
    issueDate: String(formData.get("issueDate") ?? ""),
    operationDate: String(formData.get("operationDate") ?? ""),
    notes: nullableString(formData.get("notes"))
  };
}

function nullableString(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}
