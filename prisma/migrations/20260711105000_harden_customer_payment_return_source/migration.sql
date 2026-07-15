BEGIN;

CREATE FUNCTION validate_customer_payment_return_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_payment RECORD;
BEGIN
  SELECT "invoiceId", "dueDateId"
  INTO source_payment
  FROM "customer_payments"
  WHERE "id" = NEW."paymentId";

  IF NOT FOUND
     OR NEW."invoiceId" <> source_payment."invoiceId"
     OR NEW."dueDateId" <> source_payment."dueDateId" THEN
    RAISE EXCEPTION 'Customer payment return must match its source payment';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER customer_payment_returns_source_trigger
BEFORE INSERT OR UPDATE OF "paymentId", "invoiceId", "dueDateId"
ON "customer_payment_returns"
FOR EACH ROW
EXECUTE FUNCTION validate_customer_payment_return_source();

CREATE FUNCTION protect_customer_payment_return_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "customer_payment_returns"
    WHERE "paymentId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'Customer payment source cannot change after a return exists';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER customer_payments_return_source_trigger
BEFORE UPDATE OF "invoiceId", "dueDateId"
ON "customer_payments"
FOR EACH ROW
WHEN (
  OLD."invoiceId" IS DISTINCT FROM NEW."invoiceId"
  OR OLD."dueDateId" IS DISTINCT FROM NEW."dueDateId"
)
EXECUTE FUNCTION protect_customer_payment_return_source();

COMMIT;
