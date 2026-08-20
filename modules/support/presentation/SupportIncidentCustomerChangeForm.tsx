"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Customer = { id: string; code: string; legalName: string; status: "ACTIVE" | "INACTIVE" };
type Props = {
  incident: { id: string; version: number; customerId: string; hasStore: boolean };
  customers: Customer[];
};

export function SupportIncidentCustomerChangeForm({ incident, customers }: Props) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(incident.customerId);
  const [state, setState] = useState<{ submitting: boolean; error?: boolean; message?: string }>({ submitting: false });
  const key = useRef<string | null>(null);
  const payload = useRef<string | null>(null);
  const changed = customerId !== incident.customerId;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || incident.hasStore) return;
    const data = new FormData(event.currentTarget);
    const body = {
      expectedVersion: incident.version,
      expectedCustomerId: incident.customerId,
      customerId,
      reason: String(data.get("reason") ?? "").trim(),
      confirmation: "CHANGE_INCIDENT_CUSTOMER",
    };
    const serialized = JSON.stringify(body);
    if (payload.current !== serialized) { key.current = crypto.randomUUID(); payload.current = serialized; }
    key.current ??= crypto.randomUUID();
    setState({ submitting: true });
    try {
      const response = await fetch(`/api/support/incidents/${incident.id}/customer-changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key.current, "X-CSRF-Token": await fetchCsrfToken() },
        body: serialized,
      });
      const result = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      if (response.ok) {
        key.current = null; payload.current = null;
        setState({ submitting: false, message: "Cliente de la incidencia actualizado." });
        router.refresh();
        return;
      }
      if (response.status < 500) { key.current = null; payload.current = null; }
      if (result?.code === "SUPPORT_INCIDENT_VERSION_CONFLICT" || result?.code === "SUPPORT_INCIDENT_CUSTOMER_EXPECTATION_CONFLICT") router.refresh();
      const retryAfter = response.headers.get("Retry-After");
      setState({ submitting: false, error: true, message: `${result?.message ?? "No se pudo cambiar el cliente."}${retryAfter ? ` Reintenta dentro de ${retryAfter} segundos.` : ""}` });
    } catch {
      setState({ submitting: false, error: true, message: "Resultado incierto. Reintenta sin cambiar los datos para reutilizar la clave idempotente." });
    }
  }

  return <form className="form-grid" onSubmit={submit}>
    <fieldset disabled={state.submitting || incident.hasStore}>
      <legend>Cambio administrativo de cliente</legend>
      <p className="muted">La operación conserva las comunicaciones y contactos en su cliente histórico. No está disponible para incidencias fusionadas.</p>
      {incident.hasStore ? <p className="message error">Retira primero la tienda mediante la edición de datos principales.</p> : null}
      <label>Cliente corregido<select required value={customerId} onChange={(event) => setCustomerId(event.target.value)}>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.code} · {customer.legalName}{customer.status === "INACTIVE" ? " (inactivo)" : ""}</option>)}</select></label>
      <label>Motivo<textarea name="reason" required minLength={3} maxLength={500} rows={3}/></label>
      <label className="checkbox-row"><input type="checkbox" required/> Confirmo el cambio de cliente y su registro permanente.</label>
    </fieldset>
    <div className="form-actions"><button className="button button-danger" disabled={state.submitting || incident.hasStore || !changed}>{state.submitting ? "Guardando…" : "Cambiar cliente"}</button>{state.message ? <p role={state.error ? "alert" : "status"} className={state.error ? "message error" : "message"}>{state.message}</p> : null}</div>
  </form>;
}
