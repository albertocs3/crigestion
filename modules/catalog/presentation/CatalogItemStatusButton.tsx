"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogItemListItem } from "@/modules/catalog/application/items";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function CatalogItemStatusButton({ item }: { item: CatalogItemListItem }) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const nextAction = item.status === "ACTIVE" ? "deactivate" : "reactivate";

  async function handleClick() {
    setIsPending(true);
    const csrfToken = await fetchCsrfToken();

    await fetch(`/api/catalog/items/${item.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ action: nextAction })
    });

    setIsPending(false);
    router.refresh();
  }

  return (
    <button
      className="button button-secondary button-small"
      disabled={isPending}
      onClick={handleClick}
      type="button"
    >
      {isPending
        ? "Actualizando..."
        : item.status === "ACTIVE"
          ? "Desactivar"
          : "Reactivar"}
    </button>
  );
}
