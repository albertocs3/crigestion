"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { PermissionListItem } from "@/modules/platform/application/roles";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function RoleCreateForm({
  permissions
}: {
  permissions: PermissionListItem[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const formData = new FormData(form);
    const permissionCodes = formData
      .getAll("permissionCodes")
      .map((value) => String(value));
    const csrfToken = await fetchCsrfToken();

    const response = await fetch("/api/platform/roles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        permissionCodes
      })
    });

    if (response.ok) {
      form.reset();
      setState({
        status: "success",
        message: "Rol creado."
      });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo crear el rol."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Nuevo rol</legend>
        <label>
          Codigo
          <input
            name="code"
            required
            minLength={3}
            maxLength={80}
            pattern="[a-zA-Z0-9._-]+"
            autoComplete="off"
          />
        </label>
        <label>
          Nombre
          <input name="name" required minLength={2} maxLength={120} />
        </label>
        <div className="checkbox-grid" role="group" aria-label="Permisos">
          {permissions.map((permission) => (
            <label className="checkbox-label" key={permission.code}>
              <input
                name="permissionCodes"
                type="checkbox"
                value={permission.code}
              />
              <span>
                <strong>{permission.code}</strong>
                <small>{permission.name}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear rol"}
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
