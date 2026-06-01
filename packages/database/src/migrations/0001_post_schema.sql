-- Deferred FKs, FTS indexes, updated_at triggers, billing function

ALTER TABLE "folders" DROP CONSTRAINT IF EXISTS "folders_parent_id_folders_id_fk";
--> statement-breakpoint
ALTER TABLE "folders"
  ADD CONSTRAINT "folders_parent_id_folders_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT IF EXISTS "context_sources_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "context_sources"
  ADD CONSTRAINT "context_sources_thread_id_threads_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT IF EXISTS "threads_parent_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "threads"
  ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk"
  FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT IF EXISTS "threads_origin_turn_id_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "threads"
  ADD CONSTRAINT "threads_origin_turn_id_turns_id_fk"
  FOREIGN KEY ("origin_turn_id") REFERENCES "public"."turns"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_definitions" DROP CONSTRAINT IF EXISTS "agent_definitions_base_definition_id_agent_definitions_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_definitions"
  ADD CONSTRAINT "agent_definitions_base_definition_id_agent_definitions_id_fk"
  FOREIGN KEY ("base_definition_id") REFERENCES "public"."agent_definitions"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT IF EXISTS "skills_base_skill_id_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "skills"
  ADD CONSTRAINT "skills_base_skill_id_skills_id_fk"
  FOREIGN KEY ("base_skill_id") REFERENCES "public"."skills"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_installed_skills" DROP CONSTRAINT IF EXISTS "user_installed_skills_base_skill_id_user_installed_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "user_installed_skills"
  ADD CONSTRAINT "user_installed_skills_base_skill_id_user_installed_skills_id_fk"
  FOREIGN KEY ("base_skill_id") REFERENCES "public"."user_installed_skills"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_yjs_heads" DROP CONSTRAINT IF EXISTS "document_yjs_heads_latest_checkpoint_id_document_yjs_checkpoints_id_fk";
--> statement-breakpoint
ALTER TABLE "document_yjs_heads"
  ADD CONSTRAINT "document_yjs_heads_latest_checkpoint_id_document_yjs_checkpoints_id_fk"
  FOREIGN KEY ("latest_checkpoint_id") REFERENCES "public"."document_yjs_checkpoints"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_markdown_projection_fts"
  ON "documents" USING gin (to_tsvector('simple', "markdown_projection"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_name_fts"
  ON "documents" USING gin (to_tsvector('simple', "name"));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS projects_updated_at ON "projects";
--> statement-breakpoint
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
DROP TRIGGER IF EXISTS folders_updated_at ON "folders";
--> statement-breakpoint
CREATE TRIGGER folders_updated_at
  BEFORE UPDATE ON "folders"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_updated_at ON "documents";
--> statement-breakpoint
CREATE TRIGGER documents_updated_at
  BEFORE UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
DROP TRIGGER IF EXISTS threads_updated_at ON "threads";
--> statement-breakpoint
CREATE TRIGGER threads_updated_at
  BEFORE UPDATE ON "threads"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_definitions_updated_at ON "agent_definitions";
--> statement-breakpoint
CREATE TRIGGER agent_definitions_updated_at
  BEFORE UPDATE ON "agent_definitions"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
DROP TRIGGER IF EXISTS skills_updated_at ON "skills";
--> statement-breakpoint
CREATE TRIGGER skills_updated_at
  BEFORE UPDATE ON "skills"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_installed_skills_updated_at ON "user_installed_skills";
--> statement-breakpoint
CREATE TRIGGER user_installed_skills_updated_at
  BEFORE UPDATE ON "user_installed_skills"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_subscriptions_updated_at ON "user_subscriptions";
--> statement-breakpoint
CREATE TRIGGER user_subscriptions_updated_at
  BEFORE UPDATE ON "user_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_preferences_updated_at ON "user_preferences";
--> statement-breakpoint
CREATE TRIGGER user_preferences_updated_at
  BEFORE UPDATE ON "user_preferences"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
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
  v_last_lot_id UUID;
  v_balance BIGINT;
  v_first_tx BOOLEAN;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be a positive bigint';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('credit_fifo:' || p_user_id::text));

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

    RETURN QUERY SELECT COALESCE(v_balance, 0), false;
    RETURN;
  END IF;

  v_amount_left := p_amount;
  v_first_tx := true;

  FOR v_lot IN
    SELECT id, remaining_millicredits
    FROM credit_lots
    WHERE user_id = p_user_id
      AND remaining_millicredits > 0
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
    FOR UPDATE
  LOOP
    v_last_lot_id := v_lot.id;
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
      CASE WHEN v_first_tx THEN p_usage_event_id ELSE NULL END,
      p_metadata
    );

    v_first_tx := false;
    v_amount_left := v_amount_left - v_debit;
    EXIT WHEN v_amount_left <= 0;
  END LOOP;

  IF v_amount_left > 0 THEN
    v_went_negative := true;

    IF v_last_lot_id IS NULL THEN
      SELECT id INTO v_last_lot_id
      FROM credit_lots
      WHERE user_id = p_user_id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE;
    END IF;

    IF v_last_lot_id IS NULL THEN
      INSERT INTO credit_lots (
        user_id,
        source_type,
        original_amount_millicredits,
        remaining_millicredits,
        grant_reason,
        metadata
      ) VALUES (
        p_user_id,
        'grant',
        v_amount_left,
        -v_amount_left,
        'overspend_debt',
        jsonb_build_object('auto_created', true)
      )
      RETURNING id INTO v_last_lot_id;
    ELSE
      UPDATE credit_lots
      SET remaining_millicredits = remaining_millicredits - v_amount_left
      WHERE id = v_last_lot_id;
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
      v_last_lot_id,
      p_consumption_group_id,
      CASE WHEN v_first_tx THEN p_usage_event_id ELSE NULL END,
      p_metadata
    );
  END IF;

  SELECT COALESCE(cb.total_balance_millicredits, 0)
  INTO v_balance
  FROM credit_balances cb
  WHERE cb.user_id = p_user_id;

  RETURN QUERY SELECT COALESCE(v_balance, 0), v_went_negative;
END;
$$;
