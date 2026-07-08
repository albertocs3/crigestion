"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string };

export function ChangePasswordForm() {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const formData = new FormData(form);
    const newPassword = String(formData.get("newPassword") ?? "");
    const newPasswordConfirmation = String(
      formData.get("newPasswordConfirmation") ?? ""
    );

    if (newPassword !== newPasswordConfirmation) {
      setState({
        status: "error",
        message: "La confirmacion no coincide con la nueva contrasena."
      });
      return;
    }

    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        currentPassword: String(formData.get("currentPassword") ?? ""),
        newPassword
      })
    });

    if (response.ok) {
      form.reset();
      router.push("/login");
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo cambiar la contrasena."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <div>
        <h2>Contrasena</h2>
        <p className="muted">
          Al guardar se cerrara la sesion actual y tendras que entrar de nuevo.
        </p>
      </div>
      <label>
        Contrasena actual
        <input
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          minLength={1}
          maxLength={200}
        />
      </label>
      <label>
        Nueva contrasena
        <input
          name="newPassword"
          type="password"
          required
          autoComplete="new-password"
          minLength={12}
          maxLength={200}
        />
      </label>
      <label>
        Confirmar nueva contrasena
        <input
          name="newPasswordConfirmation"
          type="password"
          required
          autoComplete="new-password"
          minLength={12}
          maxLength={200}
        />
      </label>
      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Guardando..." : "Cambiar contrasena"}
        </button>
        {state.status === "error" ? (
          <p className="message error">{state.message}</p>
        ) : null}
      </div>
    </form>
  );
}
