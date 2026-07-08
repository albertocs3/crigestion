"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerStoreCreateForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/customers/${customerId}/stores`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(storePayload(new FormData(form)))
    });

    if (response.ok) {
      form.reset();
      setState({ status: "success", message: "Tienda creada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo crear la tienda."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <StoreFields />
      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear tienda"}
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

export function StoreFields({
  defaults
}: {
  defaults?: {
    name: string;
    isPrimary: boolean;
    address: {
      line: string;
      postalCode: string;
      city: string;
      province: string | null;
      country: string;
    };
    email: string | null;
    phone: string | null;
    whatsapp: string | null;
    contact: {
      name: string | null;
      role: string | null;
      phone: string | null;
      mobile: string | null;
      whatsapp: string | null;
      email: string | null;
    };
  };
}) {
  return (
    <fieldset>
      <legend>{defaults ? "Editar tienda" : "Nueva tienda"}</legend>
      <div className="form-two-columns">
        <label>
          Nombre comercial
          <input
            name="name"
            required
            minLength={2}
            maxLength={160}
            defaultValue={defaults?.name ?? ""}
          />
        </label>
        <label className="checkbox-label">
          <input
            name="isPrimary"
            type="checkbox"
            defaultChecked={defaults?.isPrimary ?? false}
          />
          <span>
            <strong>Tienda principal</strong>
            <small>Marca esta sede como principal del cliente.</small>
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
          Email
          <input name="email" type="email" maxLength={254} defaultValue={defaults?.email ?? ""} />
        </label>
        <label>
          Telefono
          <input name="phone" maxLength={40} defaultValue={defaults?.phone ?? ""} />
        </label>
        <label>
          WhatsApp
          <input name="whatsapp" maxLength={40} defaultValue={defaults?.whatsapp ?? ""} />
        </label>
      </div>
      <div className="form-two-columns">
        <label>
          Contacto
          <input name="contactName" maxLength={160} defaultValue={defaults?.contact.name ?? ""} />
        </label>
        <label>
          Funcion
          <input name="contactRole" maxLength={120} defaultValue={defaults?.contact.role ?? ""} />
        </label>
      </div>
      <div className="form-three-columns">
        <label>
          Telefono contacto
          <input name="contactPhone" maxLength={40} defaultValue={defaults?.contact.phone ?? ""} />
        </label>
        <label>
          Movil contacto
          <input name="contactMobile" maxLength={40} defaultValue={defaults?.contact.mobile ?? ""} />
        </label>
        <label>
          Email contacto
          <input
            name="contactEmail"
            type="email"
            maxLength={254}
            defaultValue={defaults?.contact.email ?? ""}
          />
        </label>
      </div>
      <label>
        WhatsApp contacto
        <input
          name="contactWhatsapp"
          maxLength={40}
          defaultValue={defaults?.contact.whatsapp ?? ""}
        />
      </label>
      {!defaults ? (
        <label>
          Observaciones
          <textarea name="notes" maxLength={1000} rows={3} />
        </label>
      ) : null}
    </fieldset>
  );
}

export function storePayload(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    isPrimary: formData.get("isPrimary") === "on",
    addressLine: String(formData.get("addressLine") ?? ""),
    postalCode: String(formData.get("postalCode") ?? ""),
    city: String(formData.get("city") ?? ""),
    province: nullableString(formData.get("province")),
    country: String(formData.get("country") ?? "ES"),
    email: nullableString(formData.get("email")),
    phone: nullableString(formData.get("phone")),
    whatsapp: nullableString(formData.get("whatsapp")),
    contactName: nullableString(formData.get("contactName")),
    contactRole: nullableString(formData.get("contactRole")),
    contactPhone: nullableString(formData.get("contactPhone")),
    contactMobile: nullableString(formData.get("contactMobile")),
    contactWhatsapp: nullableString(formData.get("contactWhatsapp")),
    contactEmail: nullableString(formData.get("contactEmail")),
    notes: nullableString(formData.get("notes"))
  };
}

function nullableString(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}
