"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerRemittanceRejectForm({
  remittanceId
}: {
  remittanceId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const disabled = state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const formData = new FormData(event.currentTarget);
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(
      `/api/treasury/customer-remittances/${remittanceId}/reject`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          reason: String(formData.get("reason") ?? "")
        })
      }
    );

    if (response.ok) {
      setState({ status: "success", message: "Remesa rechazada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo rechazar la remesa."
    });
  }

  return (
    <form className="compact-stack" onSubmit={handleSubmit}>
      <label>
        Motivo rechazo
        <textarea
          name="reason"
          required
          minLength={3}
          maxLength={500}
          rows={2}
          disabled={disabled}
        />
      </label>
      <button className="button button-secondary button-small" disabled={disabled} type="submit">
        {state.status === "submitting" ? "Rechazando..." : "Rechazar remesa"}
      </button>
      {state.status === "success" || state.status === "error" ? (
        <span className={state.status === "error" ? "message error" : "message"}>
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
