CREATE TYPE "AccountingAccountStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "AccountingEntryOrigin" AS ENUM ('MANUAL');
CREATE TYPE "AccountingEntryStatus" AS ENUM ('POSTED', 'VOIDED');

CREATE TABLE "accounting_accounts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(9) NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "status" "AccountingAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "type" VARCHAR(80) NOT NULL,
    "level" INTEGER NOT NULL,
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounting_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_accounts_code_chk" CHECK ("code" ~ '^[0-9]{1,9}$'),
    CONSTRAINT "accounting_accounts_postable_code_chk" CHECK (NOT "isPostable" OR "code" ~ '^[0-9]{9}$')
);

CREATE TABLE "accounting_journal_entries" (
    "id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "accountingDate" DATE NOT NULL,
    "concept" VARCHAR(240) NOT NULL,
    "origin" "AccountingEntryOrigin" NOT NULL DEFAULT 'MANUAL',
    "status" "AccountingEntryStatus" NOT NULL DEFAULT 'POSTED',
    "totalDebit" DECIMAL(14,2) NOT NULL,
    "totalCredit" DECIMAL(14,2) NOT NULL,
    "createdById" UUID NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounting_journal_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_journal_entries_totals_chk" CHECK ("totalDebit" = "totalCredit" AND "totalDebit" > 0)
);

CREATE TABLE "accounting_journal_lines" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "concept" VARCHAR(240) NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounting_journal_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_journal_lines_side_chk" CHECK (
        (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0))
    )
);

CREATE UNIQUE INDEX "accounting_accounts_code_key" ON "accounting_accounts"("code");
CREATE INDEX "accounting_accounts_status_code_idx" ON "accounting_accounts"("status", "code");
CREATE UNIQUE INDEX "accounting_journal_entries_number_key" ON "accounting_journal_entries"("number");
CREATE UNIQUE INDEX "accounting_journal_entries_year_sequence_key" ON "accounting_journal_entries"("year", "sequence");
CREATE INDEX "accounting_journal_entries_status_accountingDate_id_idx" ON "accounting_journal_entries"("status", "accountingDate", "id");
CREATE INDEX "accounting_journal_entries_origin_accountingDate_id_idx" ON "accounting_journal_entries"("origin", "accountingDate", "id");
CREATE UNIQUE INDEX "accounting_journal_lines_entryId_position_key" ON "accounting_journal_lines"("entryId", "position");
CREATE INDEX "accounting_journal_lines_accountId_entryId_idx" ON "accounting_journal_lines"("accountId", "entryId");

ALTER TABLE "accounting_accounts"
    ADD CONSTRAINT "accounting_accounts_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_entries"
    ADD CONSTRAINT "accounting_journal_entries_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_entries"
    ADD CONSTRAINT "accounting_journal_entries_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_lines"
    ADD CONSTRAINT "accounting_journal_lines_entryId_fkey"
    FOREIGN KEY ("entryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_lines"
    ADD CONSTRAINT "accounting_journal_lines_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounting_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
