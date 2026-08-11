"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Props = {
  communication: { id: string; version: number; summary: string };
  categories: Array<{ id: string; name: string }>;
  responsibleUsers: Array<{ id: string; displayName: string }>;
  stores: Array<{ id: string; code: string; name: string; status: string }>;
};

export function CommunicationIncidentForm({
  communication,
  categories,
  responsibleUsers,
  stores,
}: Props) {
  const router = useRouter();
  const key = useRef<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<{
    busy: boolean;
    message?: string;
    error?: boolean;
  }>({ busy: false });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {
      expectedCommunicationVersion: communication.version,
      storeId: String(data.get("storeId") ?? "") || null,
      categoryId: String(data.get("categoryId") ?? ""),
      responsibleUserId: String(data.get("responsibleUserId") ?? ""),
      title: String(data.get("title") ?? "").trim(),
      priority: String(data.get("priority") ?? "MEDIUM"),
    };
    key.current ??= crypto.randomUUID();
    setState({ busy: true });
    try {
      const response = await fetch(
        `/api/support/communications/${communication.id}/incident`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key.current,
            "X-CSRF-Token": await fetchCsrfToken(),
          },
          body: JSON.stringify(body),
        },
      );
      const value = (await response.json().catch(() => null)) as {
        id?: string;
        message?: string;
      } | null;
      if (response.ok && value?.id) {
        key.current = null;
        router.push(`/app/support/incidents/${value.id}`);
        return;
      }
      if (response.status < 500) key.current = null;
      setState({
        busy: false,
        error: true,
        message: value?.message ?? "No se pudo crear la incidencia.",
      });
    } catch {
      setState({
        busy: false,
        error: true,
        message: "Resultado incierto. Reintenta sin cambiar los datos.",
      });
    }
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      <fieldset disabled={state.busy}>
        <legend>Crear incidencia desde esta comunicación</legend>
        <p className="muted">
          Se copiará el cliente y el resumen; la comunicación quedará vinculada
          y conservará su historial.
        </p>
        <label>
          Título
          <input
            name="title"
            required
            minLength={3}
            maxLength={200}
            defaultValue={communication.summary.slice(0, 120)}
          />
        </label>
        <label>
          Categoría
          <select name="categoryId" required>
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Responsable
          <select name="responsibleUserId" required>
            {responsibleUsers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tienda
          <select name="storeId" defaultValue="">
            <option value="">Cliente general</option>
            {stores
              .filter((item) => item.status === "ACTIVE")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.code} · {item.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Prioridad
          <select name="priority" defaultValue="MEDIUM">
            <option value="LOW">Baja</option>
            <option value="MEDIUM">Media</option>
            <option value="HIGH">Alta</option>
            <option value="URGENT">Urgente</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            required
          />{" "}
          Confirmo la creación y el vínculo permanente con esta comunicación.
        </label>
      </fieldset>
      <div className="form-actions">
        <button
          className="button"
          disabled={
            state.busy ||
            !confirmed ||
            categories.length === 0 ||
            responsibleUsers.length === 0
          }
        >
          {state.busy ? "Creando…" : "Crear incidencia"}
        </button>
        {state.message ? (
          <p
            role="status"
            className={state.error ? "message error" : "message"}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
