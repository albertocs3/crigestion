"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerRemittanceCancelButton({
  remittanceId
}: {
  remittanceId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const disabled = state.status === "submitting";

  async function cancelRemittance() {
    setState({ status: "submitting" });

    const csrfToken = await fetchCsrfToken();
    const response = await fetch(
      `/api/treasury/customer-remittances/${remittanceId}/cancel`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": crypto.randomUUID(),
          "X-CSRF-Token": csrfToken
        }
      }
    );

    if (response.ok) {
      setState({ status: "success", message: "Remesa cancelada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo cancelar la remesa."
    });
  }

  return (
    <div className="compact-stack">
      <button
        className="button button-secondary button-small"
        disabled={disabled}
        type="button"
        onClick={cancelRemittance}
      >
        {state.status === "submitting" ? "Cancelando..." : "Cancelar"}
      </button>
      {state.status === "success" || state.status === "error" ? (
        <span className={state.status === "error" ? "message error" : "message"}>
          {state.message}
        </span>
      ) : null}
    </div>
  );
}
