"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NotificationDto } from "@/modules/platform/application/notifications";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import { NotificationStateActions } from "@/modules/platform/presentation/NotificationStateActions";

type TargetState = "READ" | "UNREAD" | "ARCHIVED";

export function NotificationInbox({ items }: { items: NotificationDto[] }) {
  const router = useRouter();
  const eligible = useMemo(() => items.filter((item) => item.status !== "ARCHIVED"), [items]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<TargetState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const selected = items.filter((item) => selectedIds.has(item.id));
  const allSelected = eligible.length > 0 && selectedIds.size === eligible.length;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedIds.size > 0 && !allSelected;
  }, [allSelected, selectedIds.size]);

  useEffect(() => {
    const visibleIds = new Set(eligible.map((item) => item.id));
    setSelectedIds((current) => new Set([...current].filter((id) => visibleIds.has(id))));
  }, [eligible]);

  function toggle(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setError(null); setMessage(null);
  }

  async function changeBulkState(state: TargetState) {
    if (selected.length === 0 || selected.some((item) => item.status === "ARCHIVED" || item.status === state)) return;
    if (state === "ARCHIVED" && !window.confirm(`¿Archivar ${selected.length} notificación${selected.length === 1 ? "" : "es"}? Esta acción no se puede deshacer.`)) return;
    const payload = JSON.stringify({ state, items: selected.map(({ id, version }) => ({ id, expectedVersion: version })) });
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    setPending(state); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/notifications/bulk-state-changes", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key, "X-CSRF-Token": await fetchCsrfToken() }, body: payload });
      const body = await response.json().catch(() => null) as { affectedCount?: number; code?: string; message?: string } | null;
      if (!response.ok) {
        if (response.status < 500) retry.current = null;
        if (body?.code === "NOTIFICATION_BULK_VERSION_CONFLICT") router.refresh();
        throw new Error(body?.message ?? "No se pudieron actualizar las notificaciones.");
      }
      retry.current = null;
      setSelectedIds(new Set());
      setMessage(`${body?.affectedCount ?? selected.length} notificación${(body?.affectedCount ?? selected.length) === 1 ? " actualizada" : "es actualizadas"}.`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron actualizar las notificaciones.");
    } finally { setPending(null); }
  }

  const canChangeTo = (state: TargetState) => selected.length > 0 && selected.every((item) => item.status !== "ARCHIVED" && item.status !== state);

  return <div className="stack">
    {eligible.length > 0 ? <section className="panel stack" aria-labelledby="notification-bulk-heading">
      <div><h2 id="notification-bulk-heading">Acciones sobre la página</h2><p className="muted">Selecciona hasta {items.length} notificaciones visibles. Los cambios se aplican por completo o no se aplica ninguno.</p></div>
      <label className="form-actions"><input ref={selectAllRef} type="checkbox" checked={allSelected} disabled={pending !== null} onChange={() => setSelectedIds(allSelected ? new Set() : new Set(eligible.map((item) => item.id)))} /> Seleccionar las {eligible.length} disponibles en esta página</label>
      <p className="muted" aria-live="polite">{selected.length} seleccionada{selected.length === 1 ? "" : "s"}</p>
      <div className="form-actions">
        <button className="button button-secondary button-small" type="button" disabled={pending !== null || !canChangeTo("READ")} onClick={() => changeBulkState("READ")}>{pending === "READ" ? "Guardando…" : "Marcar como leídas"}</button>
        <button className="button button-secondary button-small" type="button" disabled={pending !== null || !canChangeTo("UNREAD")} onClick={() => changeBulkState("UNREAD")}>{pending === "UNREAD" ? "Guardando…" : "Marcar como no leídas"}</button>
        <button className="button button-secondary button-small" type="button" disabled={pending !== null || !canChangeTo("ARCHIVED")} onClick={() => changeBulkState("ARCHIVED")}>{pending === "ARCHIVED" ? "Archivando…" : "Archivar"}</button>
      </div>
      {error ? <p className="message error" role="alert">{error}</p> : null}
      {message ? <p className="message success" role="status">{message}</p> : null}
    </section> : null}
    <ul className="stack" aria-label="Notificaciones">{items.map((item) => <li className="panel stack" key={item.id}>
      {item.status !== "ARCHIVED" ? <label className="form-actions"><input type="checkbox" checked={selectedIds.has(item.id)} disabled={pending !== null} onChange={() => toggle(item.id)} /> Seleccionar notificación de la incidencia {item.incident.number}</label> : null}
      <div className="form-actions"><span className={`badge ${item.severity === "URGENT" || item.severity === "CRITICAL" ? "error" : "neutral"}`}>{severityLabel(item.severity)}</span><span className="badge neutral">{statusLabel(item.status)}</span></div>
      <div><strong>{messageLabel(item.messageCode)}</strong><p className="muted">Incidencia {item.incident.number}</p><time className="muted" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}</time></div>
      <div className="form-actions"><Link className="button button-secondary button-small" href={item.incident.href}>Abrir incidencia</Link><NotificationStateActions id={item.id} status={item.status} version={item.version}/></div>
    </li>)}</ul>
  </div>;
}

function statusLabel(value: string) { return ({ UNREAD: "Sin leer", READ: "Leída", ARCHIVED: "Archivada" } as Record<string,string>)[value] ?? value; }
function severityLabel(value: string) { return ({ INFO: "Información", URGENT: "Urgente", CRITICAL: "Crítica" } as Record<string,string>)[value] ?? value; }
function messageLabel(value: string) { return ({ "support.incident.assigned": "Nueva incidencia asignada", "support.incident.reassigned": "Incidencia reasignada", "support.incident.urgent": "Incidencia urgente", "support.incident.collaborator-added": "Incorporación como colaborador", "support.incident.collaborator-action": "Nueva actuación de un colaborador", "support.incident.reopened": "Incidencia reabierta" } as Record<string,string>)[value] ?? "Nueva notificación"; }
