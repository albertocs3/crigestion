"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function UserStatusButton({
  userId,
  status,
  isCurrentUser
}: {
  userId: string;
  status: string;
  isCurrentUser: boolean;
}) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isActive = status === "ACTIVE";
  const action = isActive ? "deactivate" : "reactivate";

  async function handleClick() {
    setIsSubmitting(true);
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/platform/users/${userId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ action })
    });

    setIsSubmitting(false);

    if (response.ok) {
      router.refresh();
    }
  }

  return (
    <button
      className="button button-secondary button-small"
      disabled={isSubmitting || isCurrentUser}
      type="button"
      onClick={handleClick}
    >
      {isSubmitting ? "Guardando..." : isActive ? "Desactivar" : "Reactivar"}
    </button>
  );
}
