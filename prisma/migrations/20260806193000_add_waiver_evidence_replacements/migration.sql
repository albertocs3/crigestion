BEGIN;

ALTER TABLE "subscription_renewal_waiver_review_evidence"
  DROP CONSTRAINT "subscription_renewal_waiver_review_evidence_review_kind_key",
  ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "supersedesEvidenceId" UUID,
  ADD COLUMN "replacementRequestId" UUID;

CREATE UNIQUE INDEX "subscription_renewal_waiver_review_evidence_review_kind_sequence_key"
  ON "subscription_renewal_waiver_review_evidence" ("reviewId", "kind", "sequence");
CREATE UNIQUE INDEX "subscription_renewal_waiver_review_evidence_id_company_key"
  ON "subscription_renewal_waiver_review_evidence" ("id", "companyId");
CREATE UNIQUE INDEX "subscription_renewal_waiver_review_evidence_supersedes_key"
  ON "subscription_renewal_waiver_review_evidence" ("supersedesEvidenceId") WHERE "supersedesEvidenceId" IS NOT NULL;
CREATE UNIQUE INDEX "subscription_renewal_waiver_review_evidence_replacement_request_key"
  ON "subscription_renewal_waiver_review_evidence" ("replacementRequestId") WHERE "replacementRequestId" IS NOT NULL;

CREATE TABLE "accounting_waiver_evidence_replacement_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "sourceEvidenceId" UUID NOT NULL,
  "reversalRequestId" UUID NOT NULL,
  "fiscalYearId" UUID NOT NULL,
  "status" "AccountingWaiverReplacementRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "reasonCode" "AccountingWaiverReplacementReasonCode" NOT NULL,
  "reasonDetail" VARCHAR(500) NOT NULL,
  "accountingDate" DATE NOT NULL,
  "concept" VARCHAR(240) NOT NULL,
  "requestedById" UUID NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedById" UUID,
  "approvedAt" TIMESTAMPTZ(3),
  "rejectedById" UUID,
  "rejectedAt" TIMESTAMPTZ(3),
  "rejectionDetail" VARCHAR(500),
  "cancelledById" UUID,
  "cancelledAt" TIMESTAMPTZ(3),
  "proposalSnapshot" JSONB NOT NULL,
  "replacementSnapshot" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_id_company_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_state_chk" CHECK (
    ("status" = 'REQUESTED' AND "version" = 1 AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionDetail" IS NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL AND "replacementSnapshot" IS NULL)
    OR ("status" = 'COMPLETED' AND "version" = 2 AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionDetail" IS NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL AND "replacementSnapshot" IS NOT NULL)
    OR ("status" = 'REJECTED' AND "version" = 2 AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "rejectedById" IS NOT NULL AND "rejectedAt" IS NOT NULL AND length(btrim("rejectionDetail")) >= 10
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL AND "replacementSnapshot" IS NULL)
    OR ("status" = 'CANCELLED' AND "version" = 2 AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionDetail" IS NULL
      AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL AND "replacementSnapshot" IS NULL)
  ),
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_detail_chk" CHECK (
    length(btrim("reasonDetail")) >= 10 AND length(btrim("concept")) >= 2
    AND jsonb_typeof("proposalSnapshot") = 'object'
    AND ("replacementSnapshot" IS NULL OR jsonb_typeof("replacementSnapshot") = 'object')
  ),
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_company_fkey" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_review_fkey" FOREIGN KEY ("reviewId", "companyId") REFERENCES "subscription_renewal_waiver_reviews" ("id", "companyId") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_source_fkey" FOREIGN KEY ("sourceEvidenceId", "companyId") REFERENCES "subscription_renewal_waiver_review_evidence" ("id", "companyId") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_reversal_fkey" FOREIGN KEY ("reversalRequestId") REFERENCES "accounting_waiver_reversal_requests" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_fiscal_year_fkey" FOREIGN KEY ("fiscalYearId", "companyId") REFERENCES "accounting_fiscal_years" ("id", "companyId") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_requested_by_fkey" FOREIGN KEY ("requestedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_approved_by_fkey" FOREIGN KEY ("approvedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_rejected_by_fkey" FOREIGN KEY ("rejectedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_requests_cancelled_by_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users" ("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "accounting_waiver_evidence_replacement_requests_active_source_key"
  ON "accounting_waiver_evidence_replacement_requests" ("sourceEvidenceId") WHERE "status" IN ('REQUESTED', 'COMPLETED');
CREATE UNIQUE INDEX "accounting_waiver_evidence_replacement_requests_active_reversal_key"
  ON "accounting_waiver_evidence_replacement_requests" ("reversalRequestId") WHERE "status" IN ('REQUESTED', 'COMPLETED');
CREATE INDEX "accounting_waiver_evidence_replacement_requests_company_status_requested_idx"
  ON "accounting_waiver_evidence_replacement_requests" ("companyId", "status", "requestedAt", "id");
CREATE INDEX "accounting_waiver_evidence_replacement_requests_review_requested_idx"
  ON "accounting_waiver_evidence_replacement_requests" ("reviewId", "requestedAt", "id");
CREATE INDEX "accounting_waiver_evidence_replacement_requests_source_requested_idx"
  ON "accounting_waiver_evidence_replacement_requests" ("sourceEvidenceId", "requestedAt", "id");
CREATE INDEX "accounting_waiver_evidence_replacement_requests_reversal_requested_idx"
  ON "accounting_waiver_evidence_replacement_requests" ("reversalRequestId", "requestedAt", "id");

CREATE TABLE "accounting_waiver_evidence_replacement_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "requestId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "concept" VARCHAR(240) NOT NULL,
  "debit" DECIMAL(14,2) NOT NULL,
  "credit" DECIMAL(14,2) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "accounting_waiver_evidence_replacement_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounting_waiver_evidence_replacement_lines_request_position_key" UNIQUE ("requestId", "position"),
  CONSTRAINT "accounting_waiver_evidence_replacement_lines_amount_chk" CHECK (
    "position" > 0 AND length(btrim("concept")) > 0
    AND (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0))
  ),
  CONSTRAINT "accounting_waiver_evidence_replacement_lines_request_fkey" FOREIGN KEY ("requestId") REFERENCES "accounting_waiver_evidence_replacement_requests" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_lines_account_fkey" FOREIGN KEY ("accountId") REFERENCES "accounting_accounts" ("id") ON DELETE RESTRICT
);
CREATE INDEX "accounting_waiver_evidence_replacement_lines_account_request_idx"
  ON "accounting_waiver_evidence_replacement_lines" ("accountId", "requestId");

CREATE TABLE "accounting_waiver_evidence_replacement_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "requestVersion" INTEGER NOT NULL,
  "type" "AccountingWaiverReplacementEventType" NOT NULL,
  "actorId" UUID NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "correlationId" VARCHAR(100),
  CONSTRAINT "accounting_waiver_evidence_replacement_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounting_waiver_evidence_replacement_events_request_version_key" UNIQUE ("requestId", "requestVersion"),
  CONSTRAINT "accounting_waiver_evidence_replacement_events_version_chk" CHECK ("requestVersion" IN (1, 2)),
  CONSTRAINT "accounting_waiver_evidence_replacement_events_company_fkey" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_events_request_fkey" FOREIGN KEY ("requestId") REFERENCES "accounting_waiver_evidence_replacement_requests" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_evidence_replacement_events_actor_fkey" FOREIGN KEY ("actorId") REFERENCES "users" ("id") ON DELETE RESTRICT
);
CREATE INDEX "accounting_waiver_evidence_replacement_events_company_occurred_idx"
  ON "accounting_waiver_evidence_replacement_events" ("companyId", "occurredAt", "id");

ALTER TABLE "subscription_renewal_waiver_review_evidence"
  ADD CONSTRAINT "subscription_renewal_waiver_review_evidence_supersedes_fkey" FOREIGN KEY ("supersedesEvidenceId") REFERENCES "subscription_renewal_waiver_review_evidence" ("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_renewal_waiver_review_evidence_replacement_request_fkey" FOREIGN KEY ("replacementRequestId") REFERENCES "accounting_waiver_evidence_replacement_requests" ("id") ON DELETE RESTRICT;

ALTER TABLE "accounting_journal_entries"
  ADD COLUMN "waiverReplacementRequestId" UUID,
  ADD CONSTRAINT "accounting_journal_entries_waiverReplacementRequestId_key" UNIQUE ("waiverReplacementRequestId"),
  ADD CONSTRAINT "accounting_journal_entries_waiverReplacementRequestId_fkey" FOREIGN KEY ("waiverReplacementRequestId") REFERENCES "accounting_waiver_evidence_replacement_requests" ("id") ON DELETE RESTRICT;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Accounting.RequestWaiverEvidenceReplacements', 'Solicitar sustituciones de evidencia contable de condonaciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Accounting.ApproveWaiverEvidenceReplacements', 'Aprobar sustituciones de evidencia contable de condonaciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id" FROM "roles" role JOIN "permissions" permission
  ON permission."code" IN ('Accounting.RequestWaiverEvidenceReplacements', 'Accounting.ApproveWaiverEvidenceReplacements')
WHERE role."isProtected" = true AND role."code" IN ('Administrator', 'Administrador') ON CONFLICT DO NOTHING;

COMMIT;
