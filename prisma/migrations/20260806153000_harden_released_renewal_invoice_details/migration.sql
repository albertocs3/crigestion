CREATE OR REPLACE FUNCTION "prevent_released_renewal_invoice_detail_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "subscription_renewal_reservations"
    WHERE "status" = 'RELEASED'
      AND (
        "invoiceId" = CASE WHEN TG_OP = 'INSERT' THEN NEW."invoiceId" ELSE OLD."invoiceId" END
        OR (TG_OP = 'UPDATE' AND "invoiceId" = NEW."invoiceId")
      )
  ) THEN
    RAISE EXCEPTION 'Released subscription renewal invoice detail is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
