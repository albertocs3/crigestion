BEGIN;

CREATE OR REPLACE FUNCTION "protect_accounting_waiver_replacement_entry"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."waiverReplacementRequestId" IS NOT NULL THEN
    RAISE EXCEPTION 'Accounting waiver replacement entries cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."waiverReplacementRequestId" IS NOT NULL THEN
    RAISE EXCEPTION 'Accounting waiver replacement entries are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

COMMIT;
