"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function CustomerStatusButton({
  customerId,
  status
}: {
  customerId: string;
  status: "ACTIVE" | "INACTIVE";
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle");
  const isActive = status === "ACTIVE";
  const action = isActive ? "deactivate" : "reactivate";

  async function handleClick() {
    setState("submitting");
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/customers/${customerId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ action })
    });

    if (response.ok) {
      router.refresh();
      setState("idle");
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
