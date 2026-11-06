-- migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "change_trail_delivery_outbox_pending"
  ON "change_trail_delivery_outbox" USING btree ("created_at");
