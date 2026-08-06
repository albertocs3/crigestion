INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Subscriptions.RunRenewals', 'Preparar y liberar renovaciones de suscripciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Subscriptions.ConfirmRenewals', 'Confirmar renovaciones de suscripciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" IN ('Subscriptions.RunRenewals', 'Subscriptions.ConfirmRenewals')
WHERE role."code" = 'Administrator'
ON CONFLICT DO NOTHING;

CREATE FUNCTION "prevent_released_renewal_invoice_detail_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_invoice_id UUID;
BEGIN
  target_invoice_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END;
  IF EXISTS (
    SELECT 1 FROM "subscription_renewal_reservations"
    WHERE "invoiceId" = target_invoice_id AND "status" = 'RELEASED'
  ) THEN
    RAISE EXCEPTION 'Released subscription renewal invoice detail is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "released_renewal_invoice_lines_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
FOR EACH ROW EXECUTE FUNCTION "prevent_released_renewal_invoice_detail_mutation"();
CREATE TRIGGER "released_renewal_invoice_tax_summaries_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "invoice_tax_summaries"
FOR EACH ROW EXECUTE FUNCTION "prevent_released_renewal_invoice_detail_mutation"();
CREATE TRIGGER "released_renewal_invoice_due_dates_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "invoice_due_dates"
FOR EACH ROW EXECUTE FUNCTION "prevent_released_renewal_invoice_detail_mutation"();

CREATE FUNCTION "prevent_released_renewal_invoice_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "subscription_renewal_reservations"
    WHERE "invoiceId" = OLD."id" AND "status" = 'RELEASED'
  ) THEN
    RAISE EXCEPTION 'Released subscription renewal invoice is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "released_renewal_invoices_immutable"
BEFORE UPDATE OR DELETE ON "invoices"
FOR EACH ROW EXECUTE FUNCTION "prevent_released_renewal_invoice_mutation"();
