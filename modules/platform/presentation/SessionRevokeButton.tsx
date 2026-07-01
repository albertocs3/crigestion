"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string };

export function SessionRevokeButton({
  sessionId,
  isCurrentSession
}: {
  sessionId: string;
  isCurrentSession: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleClick() {
    setState({ status: "submitting" });

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(`/api/platform/sessions/${sessionId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({ action: "revoke" })
      });

      if (response.ok) {
        router.refresh();
        setState({ status: "idle" });
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setState({
        status: "error",
        message: body?.message ?? body?.code ?? "No se pudo revocar la sesion."
      });
    } catch {
      setState({
        status: "error",
        message: "No se pudo revocar la sesion."
      });
    }
  }

  return (
    <div className="stack compact-stack">
      <button
        className="button button-secondary button-small"
        disabled={state.status === "submitting" || isCurrentSession}
        type="button"
        onClick={handleClick}
      >
        {isCurrentSession
          ? "Sesion actual"
          : state.status === "submitting"
            ? "Revocando..."
            : "Revocar"}
      </button>
      {state.status === "error" ? (
        <p className="message error">{state.message}</p>
      ) : null}
    </div>
  );
}
