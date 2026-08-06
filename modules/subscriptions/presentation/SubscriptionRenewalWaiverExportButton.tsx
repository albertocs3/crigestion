"use client";

import { useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Props = {
  filters: {
    reasonCode?: string;
    customerId?: string;
    search?: string;
    periodFrom?: string;
    periodTo?: string;
    waivedFrom: string;
    waivedTo: string;
  };
};

export function SubscriptionRenewalWaiverExportButton({ filters }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function download() {
    setBusy(true); setMessage(null);
    try {
      const csrf = await fetchCsrfToken();
      const response = await fetch("/api/subscriptions/renewal-waivers/export", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([, value]) => value)))
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { message?: string; code?: string } | null;
        setMessage(error?.message ?? error?.code ?? "No se pudo exportar el informe.");
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "condonaciones-renovacion.csv";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename; anchor.click();
      URL.revokeObjectURL(url);
      setMessage("Exportación generada y auditada.");
    } catch { setMessage("No se pudo conectar con el servidor."); }
    finally { setBusy(false); }
  }
  return <div className="stack">
    <button className="button button-secondary" type="button" disabled={busy} onClick={() => void download()}>{busy ? "Exportando..." : "Exportar CSV"}</button>
    {message ? <span className="cell-detail" aria-live="polite">{message}</span> : null}
  </div>;
}
