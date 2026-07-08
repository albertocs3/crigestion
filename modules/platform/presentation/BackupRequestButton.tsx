"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function BackupRequestButton() {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleClick() {
    setState({ status: "submitting" });

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch("/api/platform/backups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({})
      });

      if (response.ok) {
        setState({
          status: "success",
          message: "Copia solicitada. El worker la procesara fuera del navegador."
        });
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setState({
        status: "error",
        message: body?.message ?? body?.code ?? "No se pudo solicitar la copia."
      });
    } catch {
      setState({
        status: "error",
        message: "No se pudo solicitar la copia."
      });
    }
  }

  return (
    <div className="stack compact-stack">
      <button
        className="button"
        disabled={state.status === "submitting"}
        type="button"
        onClick={handleClick}
      >
        {state.status === "submitting" ? "Solicitando..." : "Solicitar copia"}
      </button>
      {state.status === "success" || state.status === "error" ? (
        <p className={state.status === "error" ? "message error" : "message"}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
