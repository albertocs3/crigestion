"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  PermissionListItem,
  RoleListItem
} from "@/modules/platform/application/roles";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function RolePermissionsForm({
  role,
  permissions
}: {
  role: RoleListItem;
  permissions: PermissionListItem[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const currentPermissionCodes = new Set(
    role.permissions.map((permission) => permission.code)
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const formData = new FormData(form);
    const permissionCodes = formData
      .getAll("permissionCodes")
      .map((value) => String(value));
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/platform/roles/${role.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ permissionCodes })
    });

    if (response.ok) {
      setState({
        status: "success",
        message: "Permisos actualizados."
      });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudieron actualizar los permisos."
    });
  }

  if (role.isProtected) {
    return <span>{role.permissions.map((permission) => permission.code).join(", ")}</span>;
  }

  return (
    <form className="table-form" onSubmit={handleSubmit}>
      <div className="checkbox-grid compact-stack" role="group" aria-label={`Permisos de ${role.name}`}>
        {permissions.map((permission) => (
          <label className="checkbox-label" key={permission.code}>
            <input
              defaultChecked={currentPermissionCodes.has(permission.code)}
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
      <div className="form-actions">
        <button
          className="button button-secondary button-small"
          disabled={state.status === "submitting"}
          type="submit"
        >
          {state.status === "submitting" ? "Guardando..." : "Guardar permisos"}
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
