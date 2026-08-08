import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = (name: string) =>
  readFileSync(resolve("prisma/migrations", name, "migration.sql"), "utf8");

describe("purchase document identity migration boundaries", () => {
  it("commits the invoice backfill before altering the populated table", () => {
    const backfill = migrationSql("20260807130100_add_purchase_document_identities");
    const finalize = migrationSql("20260807130150_finalize_purchase_document_identities");

    expect(backfill).toContain('UPDATE "purchase_invoices"');
    expect(backfill).toContain("PURCHASE_DOCUMENT_IDENTITY_BACKFILL_MISMATCH");
    expect(backfill).not.toContain('ALTER TABLE "purchase_invoices" ALTER COLUMN');
    expect(finalize).not.toContain('UPDATE "purchase_invoices"');
    expect(finalize).toContain("PURCHASE_DOCUMENT_IDENTITY_BACKFILL_MISMATCH");
    expect(finalize).toContain(
      'ALTER TABLE "purchase_invoices" ALTER COLUMN "documentIdentityId" SET NOT NULL;'
    );
    expect(finalize).toContain('CREATE TRIGGER "purchase_invoice_document_identity_guard"');
  });

  it("commits the rectification mode backfill before indexing the populated table", () => {
    const backfill = migrationSql("20260808113000_add_partial_purchase_rectifications");
    const finalize = migrationSql("20260808113050_finalize_partial_purchase_rectifications");

    expect(backfill).toContain('UPDATE "purchase_invoices"');
    expect(backfill).toContain("PURCHASE_RECTIFICATION_MODE_BACKFILL_MISMATCH");
    expect(backfill).not.toContain('CREATE UNIQUE INDEX "purchase_invoices_single_full_rectification_key"');
    expect(finalize).not.toContain('UPDATE "purchase_invoices"');
    expect(finalize).toContain("PURCHASE_RECTIFICATION_MODE_BACKFILL_MISMATCH");
    expect(finalize).toContain('CREATE UNIQUE INDEX "purchase_invoices_single_full_rectification_key"');
  });
});
