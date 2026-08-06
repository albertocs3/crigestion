BEGIN;

CREATE OR REPLACE FUNCTION "assert_accounting_waiver_replacement_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_id UUID; request RECORD; event_count INTEGER; line_stats RECORD; replacement RECORD; result_count INTEGER; mismatch_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'accounting_waiver_evidence_replacement_requests' THEN
    request_id := NEW."id";
  ELSIF TG_TABLE_NAME = 'accounting_waiver_evidence_replacement_events' THEN
    request_id := NEW."requestId";
  ELSIF TG_TABLE_NAME = 'accounting_waiver_evidence_replacement_lines' THEN
    request_id := NEW."requestId";
  ELSIF TG_TABLE_NAME = 'accounting_journal_entries' THEN
    request_id := NEW."waiverReplacementRequestId";
  ELSE
    request_id := NEW."replacementRequestId";
  END IF;
  IF request_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO request FROM "accounting_waiver_evidence_replacement_requests" WHERE "id" = request_id;
  SELECT count(*) INTO event_count FROM "accounting_waiver_evidence_replacement_events" WHERE "requestId" = request_id;
  SELECT count(*) AS line_count, COALESCE(sum("debit"), 0) AS debit, COALESCE(sum("credit"), 0) AS credit
    INTO line_stats FROM "accounting_waiver_evidence_replacement_lines" WHERE "requestId" = request_id;
  IF event_count <> request."version" OR line_stats.line_count < 2 OR line_stats.debit <= 0 OR line_stats.debit <> line_stats.credit THEN
    RAISE EXCEPTION 'Accounting waiver replacement proposal ledger is inconsistent.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO result_count FROM "accounting_journal_entries" WHERE "waiverReplacementRequestId" = request_id;
  IF request."status" = 'COMPLETED' THEN
    SELECT * INTO replacement FROM "accounting_journal_entries" WHERE "waiverReplacementRequestId" = request_id;
    IF result_count <> 1 OR replacement."status" <> 'POSTED' OR
      (SELECT count(*) FROM "subscription_renewal_waiver_review_evidence" evidence
        JOIN "subscription_renewal_waiver_review_evidence" source ON source."id" = evidence."supersedesEvidenceId"
        WHERE evidence."replacementRequestId" = request_id AND evidence."reviewId" = request."reviewId"
          AND evidence."companyId" = request."companyId" AND evidence."kind" = source."kind"
          AND evidence."accountingJournalEntryId" = replacement."id" AND evidence."addedById" = request."approvedById"
          AND evidence."supersedesEvidenceId" = request."sourceEvidenceId" AND evidence."sequence" = source."sequence" + 1) <> 1 THEN
      RAISE EXCEPTION 'Completed accounting waiver replacement requires one posted entry and one evidence.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO mismatch_count FROM (
      SELECT COALESCE(proposal."position", journal."position")
      FROM (SELECT "position", "accountId", "concept", "debit", "credit" FROM "accounting_waiver_evidence_replacement_lines" WHERE "requestId" = request_id) proposal
      FULL JOIN (SELECT "position", "accountId", "concept", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = replacement."id") journal USING ("position")
      WHERE proposal."position" IS NULL OR journal."position" IS NULL OR proposal."accountId" <> journal."accountId"
        OR proposal."concept" <> journal."concept" OR proposal."debit" <> journal."debit" OR proposal."credit" <> journal."credit"
    ) mismatch;
    IF mismatch_count <> 0 THEN RAISE EXCEPTION 'Accounting waiver replacement must exactly match its approved proposal.' USING ERRCODE = 'check_violation'; END IF;
  ELSIF result_count <> 0 OR EXISTS (SELECT 1 FROM "subscription_renewal_waiver_review_evidence" WHERE "replacementRequestId" = request_id) THEN
    RAISE EXCEPTION 'Non-completed accounting waiver replacement cannot retain results.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
