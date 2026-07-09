"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function AccountingAccountCreateForm() {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const disabled = state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const formData = new FormData(form);
    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/accounting/accounts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        type: String(formData.get("type") ?? ""),
        level: String(formData.get("level") ?? "9"),
        isPostable: formData.get("isPostable") === "on"
      })
    });

    if (response.ok) {
      form.reset();
      setState({ status: "success", message: "Cuenta creada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo crear la cuenta."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Nueva cuenta</legend>
        <div className="form-three-columns">
          <label>
            Codigo
            <input name="code" required maxLength={9} disabled={disabled} />
          </label>
          <label>
            Nombre
            <input name="name" required maxLength={180} disabled={disabled} />
          </label>
          <label>
            Tipo
            <input name="type" required maxLength={80} disabled={disabled} />
          </label>
        </div>
        <div className="form-two-columns">
          <label>
            Nivel
            <input
              name="level"
              required
              type="number"
              min={1}
              max={9}
              defaultValue={9}
              disabled={disabled}
            />
          </label>
          <label className="checkbox-label">
            <input
              name="isPostable"
              type="checkbox"
              defaultChecked
              disabled={disabled}
            />
            Imputable
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="button" disabled={disabled} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear cuenta"}
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
