"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { SupportIncidentReferences } from "@/modules/support/application/incidents";

type State = { kind: "idle" | "submitting" | "error"; message?: string };

export function SupportIncidentCreateForm({
  references,
  defaultCustomerId,
}: {
  references: SupportIncidentReferences;
  defaultCustomerId?: string;
}) {
  const router = useRouter();
  const initialCustomerId =
    references.customers.find((customer) => customer.id === defaultCustomerId)
      ?.id ??
    (defaultCustomerId === undefined
      ? references.customers[0]?.id ?? ""
      : "");
  const [customerId, setCustomerId] = useState(
    initialCustomerId,
  );
  const [state, setState] = useState<State>({ kind: "idle" });
  const idempotencyKey = useRef<string | null>(null);
  const stores = useMemo(() => references.customers.find((customer) => customer.id === customerId)?.stores ?? [], [customerId, references.customers]);
  const ready = references.customers.some((customer) => customer.id === customerId) && references.categories.length > 0 && references.responsibleUsers.length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ kind: "submitting" });
    const data = new FormData(event.currentTarget);
    const body = {
      customerId: text(data, "customerId"),
      storeId: text(data, "storeId") || null,
      categoryId: text(data, "categoryId"),
      responsibleUserId: text(data, "responsibleUserId"),
      title: text(data, "title"),
      description: text(data, "description"),
      priority: text(data, "priority")
    };
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/support/incidents", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": await fetchCsrfToken() }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => null) as { id?: string; message?: string } | null;
      if (response.ok && result?.id) { idempotencyKey.current = null; router.push(`/app/support/incidents/${result.id}`); router.refresh(); return; }
      if (response.status < 500) idempotencyKey.current = null;
      setState({ kind: "error", message: result?.message ?? (response.status >= 500 ? "Resultado incierto. Reintenta sin cambiar los datos." : "No se pudo crear la incidencia.") });
    } catch { setState({ kind: "error", message: "Resultado incierto. Reintenta sin cambiar los datos para reutilizar la clave idempotente." }); }
  }

  return <form className="form-grid" onSubmit={submit}>
    <fieldset disabled={state.kind === "submitting" || !ready}>
      <legend>Nueva incidencia</legend>
      {!ready ? <p className="message error">Se necesita al menos un cliente, una categoría activa y un responsable autorizado.</p> : null}
      <div className="form-two-columns">
        <label>Cliente<select name="customerId" required value={customerId} onChange={(event) => setCustomerId(event.target.value)}>{!customerId ? <option value="">Selecciona un cliente</option> : null}{references.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.code} · {customer.legalName}{customer.status === "INACTIVE" ? " (inactivo)" : ""}</option>)}</select></label>
        <label>Tienda (opcional)<select name="storeId" key={customerId}><option value="">Sin tienda</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.code} · {store.name}{store.status === "INACTIVE" ? " (inactiva)" : ""}</option>)}</select></label>
      </div>
      <div className="form-three-columns">
        <label>Categoría<select name="categoryId" required defaultValue={references.categories[0]?.id}>{references.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label>Responsable<select name="responsibleUserId" required defaultValue={references.responsibleUsers[0]?.id}>{references.responsibleUsers.map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select></label>
        <label>Prioridad<select name="priority" defaultValue="MEDIUM"><option value="LOW">Baja</option><option value="MEDIUM">Media</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label>
      </div>
      <label>Título<input name="title" required minLength={3} maxLength={200} /></label>
      <label>Descripción<textarea name="description" required minLength={3} maxLength={4000} rows={6} /></label>
      <p className="muted">Evita incluir contraseñas, datos bancarios, información médica u otros datos sensibles innecesarios.</p>
    </fieldset>
    <div className="form-actions"><button className="button" type="submit" disabled={state.kind === "submitting" || !ready}>{state.kind === "submitting" ? "Creando…" : "Crear incidencia"}</button>{state.message ? <p className="message error" role="alert">{state.message}</p> : null}</div>
  </form>;
}

function text(data: FormData, key: string): string { return String(data.get(key) ?? "").trim(); }
