"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

const priorityOptions: Array<{ value: Priority; label: string }> = [
  { value: "LOW", label: "Baja" },
  { value: "MEDIUM", label: "Media" },
  { value: "HIGH", label: "Alta" },
  { value: "URGENT", label: "Urgente" },
];

export function SupportPriorityChangeForm({
  incidentId,
  expectedVersion,
  currentPriority,
}: {
  incidentId: string;
  expectedVersion: number;
  currentPriority: Priority;
}) {
  const router = useRouter();
  const [priority, setPriority] = useState<Priority>(currentPriority);
  const [state, setState] = useState<{
    submitting: boolean;
    message?: string;
    error?: boolean;
  }>({ submitting: false });
  const key = useRef<string | null>(null);
  const payload = useRef<string | null>(null);
  const isUrgent = priority === "URGENT" && currentPriority !== "URGENT";
  const hasChanged = priority !== currentPriority;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasChanged) return;
    setState({ submitting: true });
    const data = new FormData(event.currentTarget);
    const body = {
      expectedVersion,
      priority,
      reason: String(data.get("reason") ?? "").trim(),
    };
    const serializedBody = JSON.stringify(body);
    if (payload.current !== serializedBody) {
      key.current = crypto.randomUUID();
      payload.current = serializedBody;
    }
    const idempotencyKey = key.current ?? crypto.randomUUID();
    key.current = idempotencyKey;
    try {
      const response = await fetch(
        `/api/support/incidents/${incidentId}/priority-changes`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
            "X-CSRF-Token": await fetchCsrfToken(),
          },
          body: serializedBody,
        },
      );
      const result = (await response.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      if (response.ok) {
        key.current = null;
        payload.current = null;
        setState({ submitting: false, message: "Prioridad actualizada." });
        router.refresh();
        return;
      }
      if (response.status < 500) {
        key.current = null;
        payload.current = null;
      }
      if (result?.code === "SUPPORT_INCIDENT_VERSION_CONFLICT") router.refresh();
      const retryAfter = response.headers.get("Retry-After");
      setState({
        submitting: false,
        error: true,
        message: `${result?.message ?? "No se pudo actualizar la prioridad."}${retryAfter ? ` Reintenta dentro de ${retryAfter} segundos.` : ""}`,
      });
    } catch {
      setState({
        submitting: false,
        error: true,
        message:
          "Resultado incierto. Reintenta sin cambiar los datos para reutilizar la clave idempotente.",
      });
    }
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      <fieldset disabled={state.submitting}>
        <legend>Cambiar prioridad</legend>
        <label>
          Nueva prioridad
          <select
            name="priority"
            value={priority}
            aria-describedby={isUrgent ? "urgent-priority-notice" : undefined}
            onChange={(event) => {
              setPriority(event.target.value as Priority);
              setState({ submitting: false });
            }}
          >
            {priorityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
                {option.value === currentPriority ? " (actual)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Motivo
          <textarea name="reason" required minLength={3} maxLength={500} rows={3} />
        </label>
        {isUrgent ? (
          <div className="stack compact-stack" aria-live="polite">
            <p id="urgent-priority-notice" className="message">
              Se notificará a los usuarios autorizados para recibir incidencias urgentes.
            </p>
            <label className="checkbox-row">
              <input type="checkbox" required /> Confirmo el cambio a urgente y el envío de
              notificaciones.
            </label>
          </div>
        ) : null}
      </fieldset>
      <div className="form-actions">
        <button className="button" disabled={state.submitting || !hasChanged}>
          {state.submitting ? "Guardando…" : "Actualizar prioridad"}
        </button>
        {state.message ? (
          <p role={state.error ? "alert" : "status"} className={state.error ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
