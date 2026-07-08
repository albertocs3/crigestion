"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerAddressCreateForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/customers/${customerId}/addresses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(addressPayload(new FormData(form)))
    });

    if (response.ok) {
      form.reset();
      setState({ status: "success", message: "Direccion creada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo crear la direccion."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <AddressFields />
      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear direccion"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function AddressFields({
  defaults
}: {
  defaults?: {
    type: "BILLING" | "SHIPPING" | "OTHER";
    label: string;
    isPrimary: boolean;
    address: {
      line: string;
      postalCode: string;
      city: string;
      province: string | null;
      country: string;
    };
    contact: {
      name: string | null;
      phone: string | null;
      email: string | null;
    };
  };
}) {
  return (
    <fieldset>
      <legend>{defaults ? "Editar direccion" : "Nueva direccion"}</legend>
      <div className="form-three-columns">
        <label>
          Tipo
          <select name="type" required defaultValue={defaults?.type ?? "SHIPPING"}>
            <option value="BILLING">Facturacion</option>
            <option value="SHIPPING">Envio</option>
            <option value="OTHER">Otra</option>
          </select>
        </label>
        <label>
          Etiqueta
          <input
            name="label"
            required
            minLength={2}
            maxLength={120}
            defaultValue={defaults?.label ?? ""}
            placeholder="Almacen, oficina, obra..."
          />
        </label>
        <label className="checkbox-label">
          <input
            name="isPrimary"
            type="checkbox"
            defaultChecked={defaults?.isPrimary ?? false}
          />
          <span>
            <strong>Principal</strong>
            <small>Principal para este tipo.</small>
          </span>
        </label>
      </div>
      <label>
        Direccion
        <input
          name="addressLine"
          required
          minLength={3}
          maxLength={240}
          defaultValue={defaults?.address.line ?? ""}
        />
      </label>
      <div className="form-three-columns">
        <label>
          Codigo postal
          <input
            name="postalCode"
            required
            minLength={2}
            maxLength={20}
            defaultValue={defaults?.address.postalCode ?? ""}
          />
        </label>
        <label>
          Localidad
          <input
            name="city"
            required
            minLength={2}
            maxLength={120}
            defaultValue={defaults?.address.city ?? ""}
          />
        </label>
        <label>
          Pais
          <input
            name="country"
            required
            minLength={2}
            maxLength={2}
            defaultValue={defaults?.address.country ?? "ES"}
          />
        </label>
      </div>
      <label>
        Provincia
        <input name="province" maxLength={120} defaultValue={defaults?.address.province ?? ""} />
      </label>
      <div className="form-three-columns">
        <label>
          Contacto
          <input name="contactName" maxLength={160} defaultValue={defaults?.contact.name ?? ""} />
        </label>
        <label>
          Telefono
          <input name="phone" maxLength={40} defaultValue={defaults?.contact.phone ?? ""} />
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            maxLength={254}
            defaultValue={defaults?.contact.email ?? ""}
          />
        </label>
      </div>
      {!defaults ? (
        <label>
          Observaciones
          <textarea name="notes" maxLength={1000} rows={3} />
        </label>
      ) : null}
    </fieldset>
  );
}

export function addressPayload(formData: FormData) {
  return {
    type: String(formData.get("type") ?? "SHIPPING"),
    label: String(formData.get("label") ?? ""),
    isPrimary: formData.get("isPrimary") === "on",
    addressLine: String(formData.get("addressLine") ?? ""),
    postalCode: String(formData.get("postalCode") ?? ""),
    city: String(formData.get("city") ?? ""),
    province: nullableString(formData.get("province")),
    country: String(formData.get("country") ?? "ES"),
    contactName: nullableString(formData.get("contactName")),
    phone: nullableString(formData.get("phone")),
    email: nullableString(formData.get("email")),
    notes: nullableString(formData.get("notes"))
  };
}

function nullableString(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}
