"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CatalogCategoryCreateForm() {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch("/api/catalog/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify(catalogCategoryPayload(new FormData(form)))
      });

      if (response.ok) {
        form.reset();
        setState({ status: "success", message: "Categoria creada." });
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setState({
        status: "error",
        message: body?.message ?? body?.code ?? "No se pudo crear la categoria."
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
        <legend>Nueva categoria</legend>
        <div className="form-two-columns">
          <label>
            Nombre
            <input
              name="name"
              required
              minLength={2}
              maxLength={120}
              placeholder="Servicios recurrentes"
            />
          </label>
          <label>
            Descripcion
            <input
              name="description"
              maxLength={500}
              placeholder="Opcional"
            />
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear categoria"}
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

function catalogCategoryPayload(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    description: nullableString(formData.get("description"))
  };
}

function nullableString(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}
