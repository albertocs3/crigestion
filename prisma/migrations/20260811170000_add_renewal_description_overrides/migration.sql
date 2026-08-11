BEGIN;

ALTER TABLE "subscription_renewal_reservation_lines"
  ADD COLUMN "descriptionOverridden" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION "assert_subscription_renewal_reservation_complete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'subscription_renewal_reservations' THEN
    target_id := NEW."id";
  ELSE
    target_id := NEW."reservationId";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "subscription_renewal_reservations" reservation
    WHERE reservation."id" = target_id AND reservation."status" IN ('RESERVED', 'BILLED')
      AND (
        (SELECT count(*) FROM "subscription_lines" line WHERE line."subscriptionId" = reservation."subscriptionId")
        <> (SELECT count(*) FROM "subscription_renewal_reservation_lines" source WHERE source."reservationId" = reservation."id")
        OR (SELECT count(*) FROM "invoice_lines" line WHERE line."invoiceId" = reservation."invoiceId")
        <> (SELECT count(*) FROM "subscription_renewal_reservation_lines" source
          JOIN "subscription_renewal_reservations" sibling ON sibling."id" = source."reservationId"
          WHERE sibling."invoiceId" = reservation."invoiceId")
        OR EXISTS (
          SELECT 1 FROM "subscription_renewal_reservation_lines" source
          WHERE source."reservationId" = reservation."id" AND source."invoiceId" <> reservation."invoiceId"
        )
        OR EXISTS (
          SELECT 1
          FROM "subscription_renewal_reservation_lines" source
          JOIN "subscription_lines" subscription_line ON subscription_line."id" = source."subscriptionLineId"
          JOIN "invoice_lines" invoice_line ON invoice_line."id" = source."invoiceLineId"
          WHERE source."reservationId" = reservation."id"
            AND (
              (invoice_line."catalogItemId", invoice_line."catalogItemCodeSnapshot", invoice_line."catalogItemKindSnapshot",
                invoice_line."quantity", invoice_line."unitPrice", invoice_line."discountPercent",
                invoice_line."discountAmount", invoice_line."taxRateId", invoice_line."taxRateCodeSnapshot",
                invoice_line."taxRateNameSnapshot", invoice_line."taxRateSnapshot")
                IS DISTINCT FROM
              (subscription_line."catalogItemId", subscription_line."catalogItemCodeSnapshot", subscription_line."catalogItemKindSnapshot",
                subscription_line."quantity", subscription_line."unitPrice", subscription_line."discountPercent",
                subscription_line."discountAmount", subscription_line."taxRateId", subscription_line."taxRateCodeSnapshot",
                subscription_line."taxRateNameSnapshot", subscription_line."taxRateSnapshot")
              OR source."descriptionOverridden" IS DISTINCT FROM
                (invoice_line."description" IS DISTINCT FROM subscription_line."description")
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'A renewal reservation must map every subscription line exactly once.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
