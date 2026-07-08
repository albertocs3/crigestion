"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { CustomerStoreListItem } from "@/modules/customers/application/stores";
import { StoreFields, storePayload } from "@/modules/customers/presentation/CustomerStoreCreateForm";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerStoreEditForm({ store }: { store: CustomerStoreListItem }) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const csrfToken = await fetchCsrfToken();
    const response = await fetch(
      `/api/customers/${store.customerId}/stores/${store.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          action: "update",
          store: storePayload(new FormData(event.currentTarget))
        })
      }
    );

    if (response.ok) {
      setState({ status: "success", message: "Tienda actualizada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo actualizar la tienda."
    });
  }

  return (
    <details className="details-panel">
      <summary className="button button-secondary button-small">Editar</summary>
      <form className="table-form" onSubmit={handleSubmit}>
        <StoreFields defaults={store} />
        <div className="form-actions">
          <button className="button button-small" disabled={state.status === "submitting"} type="submit">
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
