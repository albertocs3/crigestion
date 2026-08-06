"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function SubscriptionActivateButton({ subscriptionId, version }: { subscriptionId: string; version: number }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  async function activate() {
    setSubmitting(true); setMessage(null);
    try {
      const csrfToken = await fetchCsrfToken();
      idempotencyKey.current ??= crypto.randomUUID();
      const response = await fetch(`/api/subscriptions/${subscriptionId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ version })
      });
      const body = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) setMessage(body?.message ?? body?.code ?? "No se pudo activar.");
      else { setMessage("Suscripcion activada."); router.refresh(); }
    } catch { setMessage("No se pudo conectar con el servidor."); }
    finally { setSubmitting(false); }
  }
  return <div className="compact-stack"><button className="button" type="button" disabled={submitting} onClick={activate}>{submitting ? "Activando..." : "Activar suscripcion"}</button>{message ? <p className="message" aria-live="polite">{message}</p> : null}</div>;
}
