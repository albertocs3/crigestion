"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { CustomerContactDto } from "@/modules/customers/application/contacts";

type Store = { id: string; code: string; name: string };
export function CustomerContactForm({
  customerId,
  stores,
  current,
  allowGeneral = true,
}: {
  customerId: string;
  stores: Store[];
  current?: CustomerContactDto;
  allowGeneral?: boolean;
}) {
  const router = useRouter();
  const key = useRef<string | null>(null);
  const [state, setState] = useState<{
    busy: boolean;
    message?: string;
    error?: boolean;
  }>({ busy: false });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const fields = {
      name: nullable(data.get("name")),
      role: nullable(data.get("role")),
      phone: nullable(data.get("phone")),
      mobile: nullable(data.get("mobile")),
      whatsapp: nullable(data.get("whatsapp")),
      email: nullable(data.get("email")),
    };
    const body = current
      ? {
          action: "update",
          contact: { expectedVersion: current.version, ...fields },
        }
      : { storeId: nullable(data.get("storeId")), ...fields };
    key.current ??= crypto.randomUUID();
    setState({ busy: true });
    try {
      const response = await fetch(
        current
          ? `/api/customers/${customerId}/contacts/${current.id}`
          : `/api/customers/${customerId}/contacts`,
        {
          method: current ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key.current,
            "X-CSRF-Token": await fetchCsrfToken(),
          },
          body: JSON.stringify(body),
        },
      );
      const value = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      if (response.ok) {
        key.current = null;
        setState({
          busy: false,
          message: current ? "Contacto actualizado." : "Contacto creado.",
        });
        router.refresh();
        return;
      }
      if (response.status < 500) key.current = null;
      setState({
        busy: false,
        error: true,
        message: value?.message ?? "No se pudo guardar el contacto.",
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
          {current ? `Editar ${current.name ?? "contacto"}` : "Nuevo contacto"}
        </legend>
        {!current ? (
          <label>
            Ámbito
            <select
              name="storeId"
              defaultValue={allowGeneral ? "" : stores[0]?.id}
            >
              {allowGeneral ? <option value="">Contacto general</option> : null}
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.code} · {store.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="muted">
            {current.store
              ? `${current.store.code} · ${current.store.name}`
              : "Contacto general"}
          </p>
        )}
        <label>
          Nombre
          <input
            name="name"
            minLength={2}
            maxLength={160}
            defaultValue={current?.name ?? ""}
          />
        </label>
        <label>
          Cargo o departamento
          <input
            name="role"
            minLength={2}
            maxLength={120}
            defaultValue={current?.role ?? ""}
          />
        </label>
        <label>
          Teléfono
          <input
            name="phone"
            minLength={3}
            maxLength={40}
            defaultValue={current?.phone ?? ""}
          />
        </label>
        <label>
          Móvil
          <input
            name="mobile"
            minLength={3}
            maxLength={40}
            defaultValue={current?.mobile ?? ""}
          />
        </label>
        <label>
          WhatsApp
          <input
            name="whatsapp"
            minLength={3}
            maxLength={40}
            defaultValue={current?.whatsapp ?? ""}
          />
        </label>
        <label>
          Correo
          <input
            name="email"
            type="email"
            maxLength={254}
            defaultValue={current?.email ?? ""}
          />
        </label>
      </fieldset>
      <div className="form-actions">
        <button className="button" disabled={state.busy}>
          {state.busy
            ? "Guardando…"
            : current
              ? "Guardar cambios"
              : "Crear contacto"}
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

export function CustomerContactStatusButton({
  customerId,
  contact,
}: {
  customerId: string;
  contact: CustomerContactDto;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const action = contact.status === "ACTIVE" ? "deactivate" : "reactivate";
  async function change() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/customers/${customerId}/contacts/${contact.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
            "X-CSRF-Token": await fetchCsrfToken(),
          },
          body: JSON.stringify({ action, expectedVersion: contact.version }),
        },
      );
      if (response.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className="button button-secondary"
      disabled={busy}
      onClick={change}
    >
      {busy
        ? "Guardando…"
        : contact.status === "ACTIVE"
          ? "Inactivar"
          : "Reactivar"}
    </button>
  );
}
function nullable(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}
