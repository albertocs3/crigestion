"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogTaxRateListItem } from "@/modules/catalog/application/taxRates";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function CatalogTaxRateActions({
  taxRate
}: {
  taxRate: CatalogTaxRateListItem;
}) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  async function runAction(action: "deactivate" | "reactivate" | "setDefault") {
    setPendingAction(action);

    try {
      const csrfToken = await fetchCsrfToken();
      await fetch(`/api/catalog/tax-rates/${taxRate.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({ action })
      });
      router.refresh();
    } finally {
      setPendingAction(null);
    }
  }

  const statusAction = taxRate.status === "ACTIVE" ? "deactivate" : "reactivate";

  return (
    <div className="compact-stack">
      {!taxRate.isDefault && taxRate.status === "ACTIVE" ? (
        <button
          className="button button-secondary button-small"
          disabled={pendingAction !== null}
          onClick={() => void runAction("setDefault")}
          type="button"
        >
          {pendingAction === "setDefault" ? "Marcando..." : "Por defecto"}
        </button>
      ) : null}
      <button
        className="button button-secondary button-small"
        disabled={pendingAction !== null || taxRate.isDefault}
        onClick={() => void runAction(statusAction)}
        type="button"
      >
        {pendingAction === statusAction
          ? "Actualizando..."
          : taxRate.status === "ACTIVE"
            ? "Desactivar"
            : "Reactivar"}
      </button>
    </div>
  );
}
