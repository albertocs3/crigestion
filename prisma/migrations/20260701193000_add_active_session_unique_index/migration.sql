-- Enforce the application invariant that a user can have only one non-revoked session.
-- Prisma cannot express this partial unique index in schema.prisma.

UPDATE "sessions"
SET
    "revokedAt" = "expiresAt",
    "revokeReason" = 'SESSION_EXPIRED'
WHERE "revokedAt" IS NULL
  AND "expiresAt" <= CURRENT_TIMESTAMP;

WITH ranked_sessions AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "userId"
            ORDER BY "startedAt" DESC, "id" DESC
        ) AS session_rank
    FROM "sessions"
    WHERE "revokedAt" IS NULL
)
UPDATE "sessions"
SET
    "revokedAt" = CURRENT_TIMESTAMP,
    "revokeReason" = 'DUPLICATE_ACTIVE_SESSION'
WHERE "id" IN (
    SELECT "id"
    FROM ranked_sessions
    WHERE session_rank > 1
);

CREATE UNIQUE INDEX "sessions_one_active_per_user_idx"
    ON "sessions"("userId")
    WHERE "revokedAt" IS NULL;
