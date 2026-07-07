"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string };

export function InvoiceIssueButton({
  invoiceId,
  defaultIssueDate,
  disabled
}: {
  invoiceId: string;
  defaultIssueDate: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/invoices/${invoiceId}/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        issueDate: String(new FormData(form).get("issueDate") ?? "")
      })
    });

    if (response.ok) {
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo emitir la factura."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Emision</legend>
        <label>
          Fecha definitiva de emision
          <input
            name="issueDate"
            required
            type="date"
            defaultValue={defaultIssueDate}
            disabled={disabled || state.status === "submitting"}
          />
        </label>
      </fieldset>
      <div className="form-actions">
        <button
          className="button"
          disabled={disabled || state.status === "submitting"}
          type="submit"
        >
          {state.status === "submitting" ? "Emitiendo..." : "Emitir factura"}
        </button>
        {state.status === "error" ? (
          <p className="message error">{state.message}</p>
        ) : null}
        {disabled ? (
          <p className="muted">La factura necesita al menos una linea y estar en borrador.</p>
        ) : null}
      </div>
    </form>
  );
}
