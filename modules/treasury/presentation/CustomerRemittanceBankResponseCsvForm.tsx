"use client";

import { ChangeEvent, FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string; issues?: string[] };

export function CustomerRemittanceBankResponseCsvForm({
  remittanceId,
  defaultPaymentDate
}: {
  remittanceId: string;
  defaultPaymentDate: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const disabled = state.status === "submitting";

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];

    if (!file) {
      return;
    }

    const csv = await file.text();
    const textarea = event.currentTarget.form?.elements.namedItem("csv");

    if (textarea instanceof HTMLTextAreaElement) {
      textarea.value = csv;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const formData = new FormData(event.currentTarget);
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(
      `/api/treasury/customer-remittances/${remittanceId}/import-bank-response-csv`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          paymentDate: String(formData.get("paymentDate") ?? ""),
          csv: String(formData.get("csv") ?? "")
        })
      }
    );

    if (response.ok) {
      setState({ status: "success", message: "CSV de respuesta bancaria importado." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string; issues?: string[] }
      | null;

    setState({
      status: "error",
      message:
        body?.message ?? body?.code ?? "No se pudo importar la respuesta bancaria.",
      issues: body?.issues
    });
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <div>
        <h2>Importar respuesta CSV</h2>
        <p className="muted">
          Descarga la plantilla, completa resultado con COBRADA o RECHAZADA y
          añade un motivo para cada linea rechazada.
        </p>
      </div>
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
      </div>
      <label>
        Archivo CSV completado
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={disabled}
          onChange={handleFileChange}
        />
      </label>
      <label>
        Contenido CSV
        <textarea
          name="csv"
          required
          rows={6}
          spellCheck={false}
          disabled={disabled}
          placeholder={"linea,resultado,motivo\n1,COBRADA,\n2,RECHAZADA,\"Banco rechaza una linea\""}
        />
      </label>
      <div className="form-actions">
        <button className="button button-small" disabled={disabled} type="submit">
          {state.status === "submitting" ? "Importando..." : "Importar CSV"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <span className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </span>
        ) : null}
      </div>
      {state.status === "error" && state.issues && state.issues.length > 0 ? (
        <ul className="message error">
          {state.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
