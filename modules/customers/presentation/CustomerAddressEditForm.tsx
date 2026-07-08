"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { CustomerAddressListItem } from "@/modules/customers/application/addresses";
import {
  AddressFields,
  addressPayload
} from "@/modules/customers/presentation/CustomerAddressCreateForm";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerAddressEditForm({
  address
}: {
  address: CustomerAddressListItem;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const csrfToken = await fetchCsrfToken();
    const response = await fetch(
      `/api/customers/${address.customerId}/addresses/${address.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          action: "update",
          address: addressPayload(new FormData(event.currentTarget))
        })
      }
    );

    if (response.ok) {
      setState({ status: "success", message: "Direccion actualizada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo actualizar la direccion."
    });
  }

  return (
    <details className="details-panel">
      <summary className="button button-secondary button-small">Editar</summary>
      <form className="table-form" onSubmit={handleSubmit}>
        <AddressFields defaults={address} />
        <div className="form-actions">
          <button
            className="button button-small"
            disabled={state.status === "submitting"}
            type="submit"
          >
            {state.status === "submitting" ? "Guardando..." : "Guardar"}
          </button>
        </div>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
      </form>
    </details>
  );
}
