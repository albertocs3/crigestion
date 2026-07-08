"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MaintenanceModeState } from "@/modules/platform/application/maintenance";
import type { RestoreOperationListItem } from "@/modules/platform/application/restores";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting"; action: "maintenance" | "restore" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function MaintenanceModePanel({
  maintenance,
  validatedRestores
}: {
  maintenance: MaintenanceModeState;
  validatedRestores: RestoreOperationListItem[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleEnable(formData: FormData) {
    await updateMaintenance({
      enabled: true,
      restoreOperationId: String(formData.get("restoreOperationId") ?? ""),
      reason: String(formData.get("reason") ?? "")
    });
  }

  async function handleDisable() {
    await updateMaintenance({ enabled: false });
  }

  async function handleApplyRestore() {
    setState({ status: "submitting", action: "restore" });

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch("/api/platform/restores/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({})
      });
      const body = (await response.json().catch(() => null)) as
        | { status?: string; message?: string; code?: string; errorCode?: string }
        | null;

      if (response.ok) {
        setState({
          status: "success",
          message: "Restauracion completada."
        });
        router.refresh();
        return;
      }

      setState({
        status: "error",
        message:
          body?.message ??
          body?.errorCode ??
          body?.code ??
          "No se pudo aplicar la restauracion."
      });
      router.refresh();
    } catch {
      setState({
        status: "error",
        message: "No se pudo aplicar la restauracion."
      });
    }
  }

  async function updateMaintenance(payload: unknown) {
    setState({ status: "submitting", action: "maintenance" });

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch("/api/platform/maintenance", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        setState({
          status: "success",
          message: "Modo mantenimiento actualizado."
        });
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setState({
        status: "error",
        message: body?.message ?? body?.code ?? "No se pudo actualizar mantenimiento."
      });
    } catch {
      setState({
        status: "error",
        message: "No se pudo actualizar mantenimiento."
      });
    }
  }

  return (
    <section className="stack">
      <div className="data-grid">
        <div>
          <span className="data-label">Mantenimiento</span>
          <strong>{maintenance.enabled ? "Activo" : "Inactivo"}</strong>
        </div>
        <div>
          <span className="data-label">Modo</span>
          <strong>{maintenance.mode ?? "Sin modo"}</strong>
        </div>
        <div>
          <span className="data-label">Restauracion</span>
          <strong>{maintenance.restoreOperation?.id ?? "Sin restauracion"}</strong>
        </div>
      </div>

      {maintenance.enabled ? (
        <div className="stack compact-stack">
          <p className="muted">
            Activado por {maintenance.enabledBy?.displayName ?? "usuario desconocido"} el{" "}
            {formatNullableDate(maintenance.enabledAt)}.
          </p>
          <button
            className="button button-secondary"
            disabled={state.status === "submitting"}
            type="button"
            onClick={handleDisable}
          >
            {state.status === "submitting" && state.action === "maintenance"
              ? "Actualizando..."
              : "Desactivar mantenimiento"}
          </button>
          {maintenance.mode === "RESTORE" &&
          maintenance.restoreOperation?.status === "VALIDATED" ? (
            <button
              className="button"
              disabled={state.status === "submitting"}
              type="button"
              onClick={handleApplyRestore}
            >
              {state.status === "submitting" && state.action === "restore"
                ? "Restaurando..."
                : "Restaurar ahora"}
            </button>
          ) : null}
        </div>
      ) : (
        <form action={handleEnable} className="form-grid">
          <fieldset>
            <legend>Activar modo mantenimiento</legend>
            <label>
              Restauracion validada
              <select
                disabled={validatedRestores.length === 0 || state.status === "submitting"}
                name="restoreOperationId"
                required
              >
                {validatedRestores.length === 0 ? (
                  <option value="">No hay restauraciones validadas</option>
                ) : (
                  validatedRestores.map((restore) => (
                    <option key={restore.id} value={restore.id}>
                      {formatDate(restore.validatedAt ?? restore.requestedAt)} - {restore.id}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label>
              Motivo
              <textarea
                disabled={state.status === "submitting"}
                maxLength={500}
                minLength={10}
                name="reason"
                required
                rows={3}
              />
              <span className="cell-detail">
                Describe la ventana operativa sin incluir contrasenas, certificados ni datos sensibles.
              </span>
            </label>
            <div className="form-actions">
              <button
                className="button"
                disabled={validatedRestores.length === 0 || state.status === "submitting"}
                type="submit"
              >
                {state.status === "submitting" && state.action === "maintenance"
                  ? "Activando..."
                  : "Activar mantenimiento"}
              </button>
            </div>
          </fieldset>
        </form>
      )}

      {state.status === "success" || state.status === "error" ? (
        <p className={state.status === "error" ? "message error" : "message"}>
          {state.message}
        </p>
      ) : null}
    </section>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}

function formatNullableDate(value: string | null): string {
  return value ? formatDate(value) : "Sin dato";
}
