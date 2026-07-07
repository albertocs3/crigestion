"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CatalogTaxRateCreateForm() {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch("/api/catalog/tax-rates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify(catalogTaxRatePayload(new FormData(form)))
      });

      if (response.ok) {
        form.reset();
        setState({ status: "success", message: "Tipo de IVA creado." });
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setState({
        status: "error",
        message: body?.message ?? body?.code ?? "No se pudo crear el tipo de IVA."
      });
    } catch {
      setState({
        status: "error",
        message: "No se pudo conectar con el servidor."
      });
    }
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Nuevo tipo de IVA</legend>
        <div className="form-four-columns">
          <label>
            Codigo
            <input
              name="code"
              required
              maxLength={40}
              pattern="[A-Za-z0-9_]+"
              placeholder="IVA_23"
            />
          </label>
          <label>
            Nombre
            <input
              name="name"
              required
              minLength={2}
              maxLength={120}
              placeholder="IVA general 23%"
            />
          </label>
          <label>
            Porcentaje
            <input
              name="rate"
              required
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
              placeholder="23.00"
            />
          </label>
          <label className="checkbox-label">
            <input name="isDefault" type="checkbox" />
            <span>
              <strong>Por defecto</strong>
              <small>Se propondrá en nuevas altas.</small>
            </span>
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear tipo de IVA"}
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

function catalogTaxRatePayload(formData: FormData) {
  return {
    code: String(formData.get("code") ?? ""),
    name: String(formData.get("name") ?? ""),
    rate: String(formData.get("rate") ?? ""),
    isDefault: formData.get("isDefault") === "on"
  };
}
