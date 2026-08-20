"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type References = {
  customers: Array<{ id: string; code: string; legalName: string }>;
  incidents: Array<{
    id: string;
    customerId: string;
    number: string;
    title: string;
  }>;
  contacts: Array<{
    id: string;
    customerId: string;
    name: string | null;
    role: string | null;
    phone: string | null;
    mobile: string | null;
    whatsapp: string | null;
    store: { code: string; name: string } | null;
  }>;
};
type Current = {
  id: string;
  customer: { id: string };
  version: number;
  channel: string;
  direction: string;
  occurredAt: string;
  contactNumber: string;
  contactId: string | null;
  contact: { id: string; name: string | null; role: string | null } | null;
  durationSeconds: number | null;
  summary: string;
  result: string;
  incidentId: string | null;
};

export function SupportCommunicationForm({
  references,
  current,
  defaultCustomerId,
}: {
  references: References;
  current?: Current;
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
    current?.customer.id ?? initialCustomerId,
  );
  const [channel, setChannel] = useState(current?.channel ?? "PHONE");
  const [contactId, setContactId] = useState(current?.contactId ?? "");
  const [result, setResult] = useState(
    current?.result ?? "INFORMATION_PROVIDED",
  );
  const [state, setState] = useState<{
    busy: boolean;
    message?: string;
    error?: boolean;
  }>({ busy: false });
  const key = useRef<string | null>(null);
  const incidents = references.incidents.filter(
    (item) => item.customerId === customerId,
  );
  const contacts = references.contacts.filter(
    (item) => item.customerId === customerId,
  );
  const selectedContact = contacts.find((item) => item.id === contactId);
  const historicalNumber =
    current && current.contactId === contactId && current.channel === channel
      ? current.contactNumber
      : null;
  const contactNumbers = Array.from(
    new Set(
      (channel === "WHATSAPP"
        ? [selectedContact?.whatsapp, historicalNumber]
        : [selectedContact?.phone, selectedContact?.mobile, historicalNumber]
      ).filter(Boolean),
    ),
  );
  const historicalContactMissing =
    current?.contact &&
    current.contactId === contactId &&
    !contacts.some((item) => item.id === current.contact?.id)
      ? current.contact
      : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ busy: true });
    const data = new FormData(event.currentTarget);
    const duration = String(data.get("durationSeconds") ?? "");
    const common = {
      channel,
      direction: String(data.get("direction")),
      occurredAt: new Date(String(data.get("occurredAt"))).toISOString(),
      contactId: contactId || null,
      contactNumber: String(data.get("contactNumber") ?? "").trim(),
      durationSeconds:
        channel === "PHONE" && duration ? Number(duration) * 60 : null,
      summary: String(data.get("summary") ?? "").trim(),
      result,
      incidentId: String(data.get("incidentId") ?? "") || null,
    };
    const body = current
      ? {
          expectedVersion: current.version,
          ...common,
          reason: String(data.get("reason") ?? "").trim(),
        }
      : { customerId, ...common };
    key.current ??= crypto.randomUUID();
    const url = current
      ? `/api/support/communications/${current.id}/corrections`
      : "/api/support/communications";
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
          "X-CSRF-Token": await fetchCsrfToken(),
        },
        body: JSON.stringify(body),
      });
      const value = (await response.json().catch(() => null)) as {
        id?: string;
        message?: string;
      } | null;
      if (response.ok) {
        key.current = null;
        setState({
          busy: false,
          message: current
            ? "Corrección registrada."
            : "Comunicación registrada.",
        });
        if (!current && value?.id)
          router.push(`/app/support/communications/${value.id}`);
        else router.refresh();
        return;
      }
      if (response.status < 500) key.current = null;
      setState({
        busy: false,
        error: true,
        message: value?.message ?? "No se pudo guardar.",
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
        <legend>
          {current ? "Corregir comunicación" : "Nueva comunicación"}
        </legend>
        {!current ? (
          <label>
            Cliente
            <select
              value={customerId}
              onChange={(event) => {
                setCustomerId(event.target.value);
                setContactId("");
              }}
              required
            >
              {!customerId ? (
                <option value="">Selecciona un cliente</option>
              ) : null}
              {references.customers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.code} · {item.legalName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Canal
          <select
            name="channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
          >
            <option value="PHONE">Teléfono</option>
            <option value="WHATSAPP">WhatsApp</option>
          </select>
        </label>
        <label>
          Contacto
          <select
            value={contactId}
            onChange={(event) => setContactId(event.target.value)}
          >
            <option value="">Sin contacto maestro</option>
            {contacts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.store ? `${item.store.code} · ` : "General · "}
                {item.name ?? item.role ?? "Contacto"}
              </option>
            ))}
            {historicalContactMissing ? (
              <option value={historicalContactMissing.id}>
                Histórico/inactivo ·{" "}
                {historicalContactMissing.name ??
                  historicalContactMissing.role ??
                  "Contacto"}
              </option>
            ) : null}
          </select>
        </label>
        <label>
          Dirección
          <select
            name="direction"
            defaultValue={current?.direction ?? "INBOUND"}
          >
            <option value="INBOUND">Entrante</option>
            <option value="OUTBOUND">Saliente</option>
          </select>
        </label>
        <label>
          Fecha y hora
          <input
            name="occurredAt"
            type="datetime-local"
            required
            defaultValue={toLocal(
              current?.occurredAt ? new Date(current.occurredAt) : new Date(),
            )}
          />
        </label>
        <label>
          Número utilizado
          {selectedContact ? (
            <select
              name="contactNumber"
              required
              defaultValue={current?.contactNumber ?? ""}
            >
              <option value="">Selecciona número</option>
              {contactNumbers.filter(Boolean).map((value) => (
                <option key={String(value)} value={String(value)}>
                  {value}
                </option>
              ))}
            </select>
          ) : (
            <input
              name="contactNumber"
              required
              minLength={3}
              maxLength={40}
              defaultValue={current?.contactNumber}
            />
          )}
        </label>
        {channel === "PHONE" ? (
          <label>
            Duración (minutos)
            <input
              name="durationSeconds"
              type="number"
              min={0}
              max={1440}
              defaultValue={
                current?.durationSeconds != null
                  ? current.durationSeconds / 60
                  : undefined
              }
            />
          </label>
        ) : null}
        <label>
          Resultado
          <select
            name="result"
            value={result}
            onChange={(event) => setResult(event.target.value)}
          >
            <option value="RESOLVED_NO_FOLLOW_UP">
              Resuelta sin seguimiento
            </option>
            <option value="REQUIRES_FOLLOW_UP">Requiere seguimiento</option>
            <option value="NO_ANSWER">Sin respuesta</option>
            <option value="INFORMATION_PROVIDED">Información facilitada</option>
            <option value="REFERRED_TO_INCIDENT">Derivada a incidencia</option>
          </select>
        </label>
        <label>
          Incidencia relacionada
          <select
            name="incidentId"
            required={
              result === "REQUIRES_FOLLOW_UP" ||
              result === "REFERRED_TO_INCIDENT"
            }
            defaultValue={current?.incidentId ?? ""}
          >
            <option value="">Sin incidencia</option>
            {incidents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.number} · {item.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Resumen
          <textarea
            name="summary"
            required
            minLength={3}
            maxLength={2000}
            rows={5}
            defaultValue={current?.summary}
          />
        </label>
        {current ? (
          <label>
            Motivo de la corrección
            <textarea
              name="reason"
              required
              minLength={3}
              maxLength={500}
              rows={3}
            />
          </label>
        ) : null}
      </fieldset>
      <div className="form-actions">
        <button className="button" disabled={state.busy || !customerId}>
          {state.busy
            ? "Guardando…"
            : current
              ? "Registrar corrección"
              : "Registrar comunicación"}
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
function toLocal(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
