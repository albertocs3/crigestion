BEGIN;

ALTER TYPE "AccountingFiscalYearReopenRequestStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "AccountingFiscalYearReopenRequestStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

COMMIT;
