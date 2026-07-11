-- Los datos contables legacy no incluian companyId. El backfill de ejercicios
-- solo puede asignarlos de forma segura con una unica instalacion inicializada.
DO $$
DECLARE
  initialized_installations INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM "accounting_accounts")
     OR EXISTS (SELECT 1 FROM "accounting_journal_entries") THEN
    SELECT COUNT(*) INTO initialized_installations
    FROM "installations"
    WHERE "status" = 'INITIALIZED'
      AND "companyId" IS NOT NULL
      AND "initialAdministratorId" IS NOT NULL;

    IF initialized_installations <> 1 THEN
      RAISE EXCEPTION
        'Accounting fiscal-year backfill requires exactly one initialized installation; found %',
        initialized_installations;
    END IF;
  END IF;
END $$;
