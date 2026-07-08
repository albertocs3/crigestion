"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CustomerStoreListItem } from "@/modules/customers/application/stores";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function CustomerStoreStatusButton({ store }: { store: CustomerStoreListItem }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle");
  const isActive = store.status === "ACTIVE";

  async function handleClick() {
    setState("submitting");
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/customers/${store.customerId}/stores/${store.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ action: isActive ? "deactivate" : "reactivate" })
    });

    if (response.ok) {
      setState("idle");
      router.refresh();
      return;
    }

    setState("error");
  }

  return (
    <div className="compact-stack">
      <button
        className="button button-secondary button-small"
        disabled={state === "submitting"}
        type="button"
        onClick={handleClick}
      >
        {state === "submitting" ? "Guardando..." : isActive ? "Inactivar" : "Reactivar"}
      </button>
      {state === "error" ? (
        <span className="cell-detail message error">No se pudo cambiar el estado.</span>
      ) : null}
    </div>
  );
}
