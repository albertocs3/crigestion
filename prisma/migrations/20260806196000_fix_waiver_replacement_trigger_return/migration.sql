BEGIN;

CREATE OR REPLACE FUNCTION "protect_accounting_waiver_replacement_entry"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."waiverReplacementRequestId" IS NOT NULL THEN
      RAISE EXCEPTION 'Accounting waiver replacement entries cannot be deleted.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."waiverReplacementRequestId" IS NOT NULL THEN
    RAISE EXCEPTION 'Accounting waiver replacement entries are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
