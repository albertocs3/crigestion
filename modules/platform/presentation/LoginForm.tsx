"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string };

export function LoginForm() {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const formData = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userName: String(formData.get("userName") ?? ""),
        password: String(formData.get("password") ?? "")
      })
    });

    if (response.ok) {
      router.push("/app");
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo iniciar sesion."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <label>
        Usuario
        <input
          name="userName"
          required
          autoComplete="username"
          minLength={1}
          maxLength={80}
        />
      </label>
      <label>
        Contrasena
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          minLength={1}
          maxLength={200}
        />
      </label>
      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Entrando..." : "Entrar"}
        </button>
        {state.status === "error" ? (
          <p className="message error">{state.message}</p>
        ) : null}
      </div>
    </form>
  );
}
