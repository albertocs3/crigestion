CREATE INDEX "verifactu_outbox_messages_claimed_lease_idx"
  ON "verifactu_outbox_messages"("leaseUntil", "id")
  WHERE "status" = 'CLAIMED';
