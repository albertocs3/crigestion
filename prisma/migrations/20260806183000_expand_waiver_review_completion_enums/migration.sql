BEGIN;

ALTER TYPE "SubscriptionRenewalWaiverReviewEventType" ADD VALUE 'COMPLETED';
ALTER TYPE "AccountingEntryOrigin" ADD VALUE 'WAIVER_REGULARIZATION';

CREATE TYPE "SubscriptionRenewalWaiverReviewEvidenceKind" AS ENUM ('ACCOUNTING_JOURNAL_ENTRY');

COMMIT;
