"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type RoleOption = {
  code: string;
  name: string;
};

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function UserCreateForm({ roles }: { roles: RoleOption[] }) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const formData = new FormData(form);
    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/platform/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        displayName: String(formData.get("displayName") ?? ""),
        userName: String(formData.get("userName") ?? ""),
        password: String(formData.get("password") ?? ""),
        roleCode: String(formData.get("roleCode") ?? "Administrador")
      })
    });

    if (response.ok) {
      form.reset();
      setState({
        status: "success",
        message: "Usuario creado."
      });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo crear el usuario."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Nuevo usuario</legend>
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
            autoComplete="off"
          />
        </label>
        <label>
          Rol
          <select name="roleCode" required defaultValue="Administrador">
            {roles.map((role) => (
              <option key={role.code} value={role.code}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Contrasena inicial
          <input
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={200}
            autoComplete="new-password"
          />
        </label>
      </fieldset>

      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear usuario"}
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
