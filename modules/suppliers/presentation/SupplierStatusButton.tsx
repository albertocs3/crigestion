"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function SupplierStatusButton({ id, status, version }: { id: string; status: "ACTIVE" | "INACTIVE"; version: number }) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [error, setError] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  async function update() { if (status === "ACTIVE" && !window.confirm("¿Inactivar este proveedor? Se conservará todo su histórico.")) return; setPending(true); setError(false); try { const csrf = await fetchCsrfToken(); idempotencyKey.current ??= crypto.randomUUID(); const response = await fetch(`/api/suppliers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": csrf }, body: JSON.stringify({ action: status === "ACTIVE" ? "deactivate" : "reactivate", expectedVersion: version }) }); setPending(false); if (!response.ok) { if (response.status < 500) idempotencyKey.current = null; setError(true); return; } idempotencyKey.current = null; router.refresh(); } catch { setPending(false); setError(true); } }
  return <div className="compact-stack"><button className="button button-secondary button-small" type="button" disabled={pending} onClick={update}>{pending ? "Guardando…" : status === "ACTIVE" ? "Inactivar" : "Reactivar"}</button>{error ? <span className="cell-detail message error">No se pudo cambiar.</span> : null}</div>;
}
