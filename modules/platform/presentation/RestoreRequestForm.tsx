"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BackupOperationListItem } from "@/modules/platform/application/backups";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function RestoreRequestForm({
  backups
}: {
  backups: BackupOperationListItem[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(formData: FormData) {
    setState({ status: "submitting" });

    try {
      const backupOperationId = String(formData.get("backupOperationId") ?? "");
      const reason = String(formData.get("reason") ?? "");
      const csrfToken = await fetchCsrfToken();
      const response = await fetch("/api/platform/restores", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({ backupOperationId, reason })
      });

      if (response.ok) {
        setState({
          status: "success",
          message: "Restauracion solicitada. El worker validara la copia fuera del navegador."
        });
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setState({
        status: "error",
        message: body?.message ?? body?.code ?? "No se pudo solicitar la restauracion."
      });
    } catch {
      setState({
        status: "error",
        message: "No se pudo solicitar la restauracion."
      });
    }
  }

  return (
    <form action={handleSubmit} className="form-grid">
      <fieldset>
        <legend>Solicitar validacion de restauracion</legend>
        <label>
          Copia verificada
          <select
            disabled={backups.length === 0 || state.status === "submitting"}
            name="backupOperationId"
            required
          >
            {backups.length === 0 ? (
              <option value="">No hay copias verificadas</option>
            ) : (
              backups.map((backup) => (
                <option key={backup.id} value={backup.id}>
                  {formatDate(backup.completedAt ?? backup.requestedAt)} - {backup.id}
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
            Describe la causa operativa sin incluir contrasenas, certificados ni datos sensibles.
          </span>
        </label>
        <div className="form-actions">
          <button
            className="button"
            disabled={backups.length === 0 || state.status === "submitting"}
            type="submit"
          >
            {state.status === "submitting" ? "Solicitando..." : "Solicitar validacion"}
          </button>
        </div>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}
