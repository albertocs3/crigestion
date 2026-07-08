"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { BillingConfiguration } from "@/modules/billing/application/configuration";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function BillingConfigurationForm({
  configuration
}: {
  configuration: BillingConfiguration;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const formData = new FormData(event.currentTarget);
    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/platform/configuration/billing", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        invoiceLegalFooter: String(formData.get("invoiceLegalFooter") ?? ""),
        invoiceAccentColor: String(formData.get("invoiceAccentColor") ?? "#0f766e")
      })
    });

    if (response.ok) {
      setState({
        status: "success",
        message: "Configuracion de facturacion actualizada."
      });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message:
        body?.message ?? body?.code ?? "No se pudo actualizar la configuracion."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Facturacion</legend>
        <label>
          Pie legal de factura
          <textarea
            name="invoiceLegalFooter"
            maxLength={3000}
            rows={5}
            defaultValue={configuration.invoiceLegalFooter}
          />
        </label>
        <div className="form-two-columns">
          <label>
            Color de sombreados
            <input
              name="invoiceAccentColor"
              type="color"
              defaultValue={configuration.invoiceAccentColor}
            />
          </label>
          <div className="details-panel">
            <span className="data-label">Color actual</span>
            <strong>{configuration.invoiceAccentColor}</strong>
          </div>
        </div>
      </fieldset>

      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Guardando..." : "Guardar facturacion"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
