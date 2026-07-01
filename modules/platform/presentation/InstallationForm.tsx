"use client";

import { FormEvent, useState } from "react";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function InstallationForm() {
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const formData = new FormData(event.currentTarget);
    const payload = {
      company: {
        legalName: String(formData.get("legalName") ?? ""),
        taxId: String(formData.get("taxId") ?? ""),
        email: optionalString(formData.get("email"))
      },
      administrator: {
        displayName: String(formData.get("displayName") ?? ""),
        userName: String(formData.get("userName") ?? ""),
        password: String(formData.get("password") ?? "")
      }
    };

    const response = await fetch("/api/platform/installation/initialize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      setState({
        status: "success",
        message: "Instalacion completada. Actualiza la pagina para ver el estado."
      });
      event.currentTarget.reset();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo inicializar la plataforma."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Empresa</legend>
        <label>
          Nombre legal
          <input name="legalName" required minLength={2} maxLength={200} />
        </label>
        <label>
          NIF
          <input name="taxId" required minLength={3} maxLength={32} />
        </label>
        <label>
          Email
          <input name="email" type="email" />
        </label>
      </fieldset>

      <fieldset>
        <legend>Primer administrador</legend>
        <label>
          Nombre visible
          <input name="displayName" required minLength={2} maxLength={160} />
        </label>
        <label>
          Usuario
          <input
            name="userName"
            required
            minLength={3}
            maxLength={80}
            pattern="[a-zA-Z0-9._-]+"
          />
        </label>
        <label>
          Contrasena
          <input
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
          />
        </label>
      </fieldset>

      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Inicializando..." : "Inicializar"}
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

function optionalString(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : undefined;
}
