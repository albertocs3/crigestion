"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type AssignableRole = {
  code: string;
  name: string;
};

export function UserRoleSelect({
  userId,
  currentRoleCode,
  roles,
  isCurrentUser
}: {
  userId: string;
  currentRoleCode: string;
  roles: AssignableRole[];
  isCurrentUser: boolean;
}) {
  const router = useRouter();
  const [selectedRoleCode, setSelectedRoleCode] = useState(currentRoleCode);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleChange(nextRoleCode: string) {
    setSelectedRoleCode(nextRoleCode);

    if (nextRoleCode === currentRoleCode) {
      return;
    }

    setIsSubmitting(true);

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(`/api/platform/users/${userId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          action: "changeRole",
          roleCode: nextRoleCode
        })
      });

      if (response.ok) {
        router.refresh();
        return;
      }

      setSelectedRoleCode(currentRoleCode);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <label className="sr-only-wrap">
      <span>Cambiar rol</span>
      <select
        className="table-select"
        disabled={isSubmitting || isCurrentUser}
        value={selectedRoleCode}
        onChange={(event) => void handleChange(event.target.value)}
      >
        {roles.map((role) => (
          <option key={role.code} value={role.code}>
            {role.name}
          </option>
        ))}
      </select>
    </label>
  );
}
