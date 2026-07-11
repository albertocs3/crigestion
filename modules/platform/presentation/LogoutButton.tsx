"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function LogoutButton() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleLogout() {
    setIsSubmitting(true);
    const csrfToken = await fetchCsrfToken();
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      }
    });
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      className="button button-danger-soft"
      disabled={isSubmitting}
      type="button"
      onClick={handleLogout}
    >
      {isSubmitting ? "Saliendo..." : "Cerrar sesion"}
    </button>
  );
}
