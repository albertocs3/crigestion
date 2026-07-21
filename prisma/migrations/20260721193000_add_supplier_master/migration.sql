CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "SupplierPaymentMethod" AS ENUM ('BANK_TRANSFER', 'CASH', 'DIRECT_DEBIT');
CREATE TYPE "SupplierPaymentTermsType" AS ENUM ('IMMEDIATE', 'DAYS', 'FIXED_DAY_OF_MONTH');

CREATE TABLE "suppliers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "sequenceNumber" INTEGER NOT NULL,
  "code" VARCHAR(20) NOT NULL,
  "accountingCode" VARCHAR(9) NOT NULL,
  "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
  "legalName" VARCHAR(200) NOT NULL,
  "tradeName" VARCHAR(160),
  "taxIdEncrypted" BYTEA NOT NULL,
  "taxIdLookupHash" CHAR(64) NOT NULL,
  "taxIdLast4" VARCHAR(4) NOT NULL,
  "fiscalAddressLine" VARCHAR(240) NOT NULL,
  "fiscalPostalCode" VARCHAR(20) NOT NULL,
  "fiscalCity" VARCHAR(120) NOT NULL,
  "fiscalProvince" VARCHAR(120),
  "fiscalCountry" VARCHAR(2) NOT NULL,
  "contactName" VARCHAR(160),
  "emailEncrypted" BYTEA,
  "phoneEncrypted" BYTEA,
  "bankIbanEncrypted" BYTEA,
  "bankIbanLast4" VARCHAR(4),
  "bankBicEncrypted" BYTEA,
  "defaultPaymentMethod" "SupplierPaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
  "paymentTermsType" "SupplierPaymentTermsType" NOT NULL DEFAULT 'IMMEDIATE',
  "paymentDays" INTEGER,
  "paymentFixedDay" INTEGER,
  "notes" VARCHAR(1000),
  "createdById" UUID NOT NULL,
  "updatedById" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "suppliers_sequence_check" CHECK ("sequenceNumber" BETWEEN 1 AND 99999),
  CONSTRAINT "suppliers_code_format_check" CHECK ("code" = 'PROV' || lpad("sequenceNumber"::text, 5, '0')),
  CONSTRAINT "suppliers_accounting_code_check" CHECK ("accountingCode" = '400' || lpad("sequenceNumber"::text, 6, '0')),
  CONSTRAINT "suppliers_country_format_check" CHECK ("fiscalCountry" ~ '^[A-Z]{2}$'),
  CONSTRAINT "suppliers_tax_last4_check" CHECK ("taxIdLast4" ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT "suppliers_iban_last4_check" CHECK ("bankIbanLast4" IS NULL OR "bankIbanLast4" ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT "suppliers_version_check" CHECK ("version" > 0),
  CONSTRAINT "suppliers_payment_terms_check" CHECK (
    ("paymentTermsType" = 'IMMEDIATE' AND "paymentDays" IS NULL AND "paymentFixedDay" IS NULL)
    OR ("paymentTermsType" = 'DAYS' AND "paymentDays" BETWEEN 1 AND 365 AND "paymentFixedDay" IS NULL)
    OR ("paymentTermsType" = 'FIXED_DAY_OF_MONTH' AND "paymentDays" IS NULL AND "paymentFixedDay" BETWEEN 1 AND 31)
  )
);

CREATE UNIQUE INDEX "suppliers_companyId_sequenceNumber_key" ON "suppliers"("companyId", "sequenceNumber");
CREATE UNIQUE INDEX "suppliers_companyId_code_key" ON "suppliers"("companyId", "code");
CREATE UNIQUE INDEX "suppliers_companyId_taxIdLookupHash_key" ON "suppliers"("companyId", "taxIdLookupHash");
CREATE UNIQUE INDEX "suppliers_id_accountingCode_key" ON "suppliers"("id", "accountingCode");
CREATE INDEX "suppliers_companyId_status_legalName_id_idx" ON "suppliers"("companyId", "status", "legalName", "id");
CREATE INDEX "suppliers_companyId_createdAt_id_idx" ON "suppliers"("companyId", "createdAt", "id");
CREATE INDEX "suppliers_createdById_createdAt_idx" ON "suppliers"("createdById", "createdAt");

ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_accounts" ADD COLUMN "supplierId" UUID;
ALTER TABLE "accounting_accounts" ADD CONSTRAINT "accounting_accounts_supplier_shape_check" CHECK (
  "supplierId" IS NULL OR (
    "code" ~ '^400[0-9]{6}$' AND "level" = 9 AND "isPostable" = TRUE
    AND "status" = 'ACTIVE' AND "type" = 'PASIVO'
  )
);
CREATE UNIQUE INDEX "accounting_accounts_fiscalYearId_supplierId_key" ON "accounting_accounts"("fiscalYearId", "supplierId");
CREATE INDEX "accounting_accounts_supplierId_fiscalYearId_idx" ON "accounting_accounts"("supplierId", "fiscalYearId");
ALTER TABLE "accounting_accounts" ADD CONSTRAINT "accounting_accounts_supplierId_code_fkey"
  FOREIGN KEY ("supplierId", "code") REFERENCES "suppliers"("id", "accountingCode") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_supplier_account_company()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_company UUID; fiscal_year_company UUID;
BEGIN
  IF NEW."supplierId" IS NULL THEN RETURN NEW; END IF;
  SELECT "companyId" INTO supplier_company FROM "suppliers" WHERE "id" = NEW."supplierId";
  SELECT "companyId" INTO fiscal_year_company FROM "accounting_fiscal_years" WHERE "id" = NEW."fiscalYearId";
  IF supplier_company IS NULL OR fiscal_year_company IS NULL OR supplier_company <> fiscal_year_company THEN
    RAISE EXCEPTION 'SUPPLIER_ACCOUNT_COMPANY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "accounting_accounts_supplier_company_check"
AFTER INSERT OR UPDATE OF "supplierId", "fiscalYearId" ON "accounting_accounts"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_supplier_account_company();

CREATE FUNCTION prevent_supplier_owner_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."companyId" IS DISTINCT FROM OLD."companyId" THEN
    RAISE EXCEPTION 'SUPPLIER_COMPANY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "suppliers_company_immutable"
BEFORE UPDATE OF "companyId" ON "suppliers" FOR EACH ROW EXECUTE FUNCTION prevent_supplier_owner_change();

CREATE FUNCTION prevent_supplier_fiscal_year_owner_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."companyId" IS DISTINCT FROM OLD."companyId"
     AND EXISTS (SELECT 1 FROM "accounting_accounts" WHERE "fiscalYearId" = OLD."id" AND "supplierId" IS NOT NULL) THEN
    RAISE EXCEPTION 'SUPPLIER_FISCAL_YEAR_COMPANY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "accounting_fiscal_years_supplier_company_immutable"
BEFORE UPDATE OF "companyId" ON "accounting_fiscal_years" FOR EACH ROW EXECUTE FUNCTION prevent_supplier_fiscal_year_owner_change();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Suppliers.View', 'Consultar proveedores', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Suppliers.Manage', 'Gestionar proveedores', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id" FROM "roles" role CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND permission."code" IN ('Suppliers.View', 'Suppliers.Manage')
ON CONFLICT DO NOTHING;
