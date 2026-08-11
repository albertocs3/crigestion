"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function NotificationStateActions({ id, status, version }: { id: string; status: "UNREAD" | "READ" | "ARCHIVED"; version: number }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);

  async function changeState(state: "READ" | "UNREAD" | "ARCHIVED") {
    const payload = JSON.stringify({ state, expectedVersion: version });
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    setPending(state); setError(null);
    try {
      const response = await fetch(`/api/notifications/${id}/state`, { method: "PUT", headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key, "X-CSRF-Token": await fetchCsrfToken() }, body: payload });
      const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      if (!response.ok) {
        if (response.status < 500) retry.current = null;
        if (body?.code === "NOTIFICATION_VERSION_CONFLICT") router.refresh();
        throw new Error(body?.message ?? "No se pudo actualizar la notificación.");
      }
      retry.current = null;
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo actualizar la notificación.");
    } finally { setPending(null); }
  }

  if (status === "ARCHIVED") return null;
  return <div className="stack compact-stack">
    <div className="form-actions">
      <button className="button button-secondary button-small" type="button" disabled={pending !== null} onClick={() => changeState(status === "UNREAD" ? "READ" : "UNREAD")}>{pending ? "Guardando…" : status === "UNREAD" ? "Marcar como leída" : "Marcar como no leída"}</button>
      <button className="button button-secondary button-small" type="button" disabled={pending !== null} onClick={() => changeState("ARCHIVED")}>Archivar</button>
    </div>
    {error ? <p className="message error" role="alert">{error}</p> : null}
  </div>;
}
