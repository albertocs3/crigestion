"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CustomerAddressListItem } from "@/modules/customers/application/addresses";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function CustomerAddressStatusButton({
  address
}: {
  address: CustomerAddressListItem;
}) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const nextAction = address.status === "ACTIVE" ? "deactivate" : "reactivate";

  async function handleClick() {
    setIsPending(true);
    const csrfToken = await fetchCsrfToken();

    await fetch(`/api/customers/${address.customerId}/addresses/${address.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
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
        : address.status === "ACTIVE"
          ? "Desactivar"
          : "Reactivar"}
    </button>
  );
}
