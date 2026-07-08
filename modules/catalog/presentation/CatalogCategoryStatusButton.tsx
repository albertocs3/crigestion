"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogCategoryListItem } from "@/modules/catalog/application/categories";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function CatalogCategoryStatusButton({
  category
}: {
  category: CatalogCategoryListItem;
}) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const nextAction = category.status === "ACTIVE" ? "deactivate" : "reactivate";

  async function handleClick() {
    setIsPending(true);

    try {
      const csrfToken = await fetchCsrfToken();
      await fetch(`/api/catalog/categories/${category.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({ action: nextAction })
      });
      router.refresh();
    } finally {
      setIsPending(false);
    }
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
        : category.status === "ACTIVE"
          ? "Desactivar"
          : "Reactivar"}
    </button>
  );
}
