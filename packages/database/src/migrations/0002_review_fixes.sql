-- Review fixes: indexes, pg_trgm, billing debt, triggers, functions, view
-- Function bodies GENERATED FROM src/functions/*.sql at commit time

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
UPDATE credit_lots
SET source_type = 'debt', grant_reason = NULL
WHERE grant_reason = 'overspend_debt';
--> statement-breakpoint
DROP INDEX IF EXISTS "credit_transactions_usage_event";
--> statement-breakpoint
DROP INDEX IF EXISTS "projects_user_last_activity_active";
--> statement-breakpoint
CREATE INDEX "projects_user_last_activity_active" ON "projects" USING btree ("user_id","last_activity_at" DESC NULLS LAST) WHERE "projects"."deleted_at" is null;
--> statement-breakpoint
DROP INDEX IF EXISTS "document_yjs_checkpoints_document_id_desc";
--> statement-breakpoint
CREATE INDEX "document_yjs_checkpoints_document_id_desc" ON "document_yjs_checkpoints" USING btree ("document_id","id" DESC NULLS LAST);
--> statement-breakpoint
DROP INDEX IF EXISTS "threads_project_updated_active";
--> statement-breakpoint
CREATE INDEX "threads_project_updated_active" ON "threads" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE "threads"."deleted_at" is null;
--> statement-breakpoint
DROP INDEX IF EXISTS "threads_parent_created_active";
--> statement-breakpoint
CREATE INDEX "threads_parent_created_active" ON "threads" USING btree ("parent_thread_id","created_at" DESC NULLS LAST) WHERE "threads"."parent_thread_id" IS NOT NULL AND "threads"."deleted_at" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "turns_thread_created";
--> statement-breakpoint
CREATE INDEX "turns_thread_created" ON "turns" USING btree ("thread_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
DROP INDEX IF EXISTS "turn_document_touches_document_touched";
--> statement-breakpoint
CREATE INDEX "turn_document_touches_document_touched" ON "turn_document_touches" USING btree ("document_id","touched_at" DESC NULLS LAST);
--> statement-breakpoint
DROP INDEX IF EXISTS "credit_transactions_user_created";
--> statement-breakpoint
CREATE INDEX "credit_transactions_user_created" ON "credit_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
DROP INDEX IF EXISTS "credit_lots_fifo_spend";
--> statement-breakpoint
CREATE INDEX "credit_lots_fifo_spend" ON "credit_lots" USING btree ("user_id","expires_at" ASC NULLS LAST,"created_at","id") WHERE "credit_lots"."remaining_millicredits" > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_markdown_projection_trgm" ON "documents" USING gin ("markdown_projection" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_name_trgm" ON "documents" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "credit_lots" DROP CONSTRAINT IF EXISTS "credit_lots_source_type";
--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_source_type" CHECK ("source_type" IN ('purchase', 'grant', 'subscription', 'debt'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_lots_debt_user" ON "credit_lots" USING btree ("user_id") WHERE "credit_lots"."source_type" = 'debt';
--> statement-breakpoint
ALTER TABLE "model_responses" ALTER COLUMN "usage_breakdown" DROP NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS context_sources_updated_at ON "context_sources";
--> statement-breakpoint
CREATE TRIGGER context_sources_updated_at
  BEFORE UPDATE ON "context_sources"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
DROP VIEW IF EXISTS "credit_balances";
--> statement-breakpoint
CREATE VIEW "credit_balances" AS
SELECT
  "credit_lots"."user_id",
  COALESCE(SUM("credit_lots"."remaining_millicredits"), 0) AS "total_balance_millicredits",
  COALESCE(SUM("credit_lots"."remaining_millicredits") FILTER (WHERE "credit_lots"."source_type" = 'grant'), 0) AS "grant_balance_millicredits",
  COALESCE(SUM("credit_lots"."remaining_millicredits") FILTER (WHERE "credit_lots"."source_type" = 'purchase'), 0) AS "purchased_balance_millicredits",
  COALESCE(SUM("credit_lots"."remaining_millicredits") FILTER (WHERE "credit_lots"."source_type" = 'debt'), 0) AS "debt_balance_millicredits"
FROM "credit_lots"
WHERE "credit_lots"."expires_at" IS NULL
   OR "credit_lots"."expires_at" > NOW()
   OR "credit_lots"."source_type" = 'debt'
GROUP BY "credit_lots"."user_id";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION consume_credit_lots_fifo(
  p_user_id UUID,
  p_amount BIGINT,
  p_consumption_group_id UUID,
  p_usage_event_id TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  remaining_balance BIGINT,
  went_negative BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_amount_left BIGINT;
  v_lot RECORD;
  v_debit BIGINT;
  v_went_negative BOOLEAN := false;
  v_balance BIGINT;
  v_debt_lot_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be a positive bigint';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('credit_fifo'),
    hashtext(p_user_id::text)
  );

  IF p_usage_event_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM credit_transactions
    WHERE usage_event_id = p_usage_event_id
      AND transaction_type = 'consumption'
  ) THEN
    SELECT COALESCE(cb.total_balance_millicredits, 0)
    INTO v_balance
    FROM credit_balances cb
    WHERE cb.user_id = p_user_id;

    RETURN QUERY SELECT
      COALESCE(v_balance, 0),
      COALESCE(v_balance, 0) < 0;
    RETURN;
  END IF;

  v_amount_left := p_amount;

  FOR v_lot IN
    SELECT id, remaining_millicredits
    FROM credit_lots
    WHERE user_id = p_user_id
      AND remaining_millicredits > 0
      AND source_type != 'debt'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
    FOR UPDATE
  LOOP
    v_debit := LEAST(v_lot.remaining_millicredits, v_amount_left);

    UPDATE credit_lots
    SET remaining_millicredits = remaining_millicredits - v_debit
    WHERE id = v_lot.id;

    INSERT INTO credit_transactions (
      user_id,
      transaction_type,
      amount_millicredits,
      lot_id,
      consumption_group_id,
      usage_event_id,
      metadata
    ) VALUES (
      p_user_id,
      'consumption',
      -v_debit,
      v_lot.id,
      p_consumption_group_id,
      p_usage_event_id,
      p_metadata
    );

    v_amount_left := v_amount_left - v_debit;
    EXIT WHEN v_amount_left <= 0;
  END LOOP;

  IF v_amount_left > 0 THEN
    v_went_negative := true;

    SELECT id INTO v_debt_lot_id
    FROM credit_lots
    WHERE user_id = p_user_id
      AND source_type = 'debt'
    FOR UPDATE;

    IF v_debt_lot_id IS NULL THEN
      INSERT INTO credit_lots (
        user_id,
        source_type,
        original_amount_millicredits,
        remaining_millicredits,
        metadata
      ) VALUES (
        p_user_id,
        'debt',
        v_amount_left,
        -v_amount_left,
        jsonb_build_object('auto_created', true)
      )
      RETURNING id INTO v_debt_lot_id;
    ELSE
      UPDATE credit_lots
      SET
        original_amount_millicredits = original_amount_millicredits + v_amount_left,
        remaining_millicredits = remaining_millicredits - v_amount_left
      WHERE id = v_debt_lot_id;
    END IF;

    INSERT INTO credit_transactions (
      user_id,
      transaction_type,
      amount_millicredits,
      lot_id,
      consumption_group_id,
      usage_event_id,
      metadata
    ) VALUES (
      p_user_id,
      'consumption',
      -v_amount_left,
      v_debt_lot_id,
      p_consumption_group_id,
      p_usage_event_id,
      p_metadata
    );
  END IF;

  SELECT COALESCE(cb.total_balance_millicredits, 0)
  INTO v_balance
  FROM credit_balances cb
  WHERE cb.user_id = p_user_id;

  RETURN QUERY SELECT
    COALESCE(v_balance, 0),
    COALESCE(v_balance, 0) < 0;
END;
$$;
