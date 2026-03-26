-- +goose Up
-- +goose ENVSUB ON
-- +goose StatementBegin
CREATE TYPE ${TABLE_PREFIX}credit_source_type AS ENUM ('purchase', 'grant');
CREATE TYPE ${TABLE_PREFIX}credit_transaction_type AS ENUM (
  'purchase',
  'grant',
  'consumption',
  'expiration',
  'refund'
);

CREATE TABLE ${TABLE_PREFIX}credit_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type ${TABLE_PREFIX}credit_source_type NOT NULL,
  original_amount_millicredits bigint NOT NULL CHECK (original_amount_millicredits > 0),
  remaining_millicredits bigint NOT NULL,
  expires_at timestamptz NULL,
  stripe_session_id text NULL,
  grant_reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT ${TABLE_PREFIX}credit_lots_stripe_session_required CHECK (
    (source_type = 'purchase' AND stripe_session_id IS NOT NULL AND grant_reason IS NULL)
    OR
    (source_type = 'grant' AND stripe_session_id IS NULL)
  ),
  CONSTRAINT ${TABLE_PREFIX}credit_lots_grant_reason_required CHECK (
    (source_type = 'grant' AND grant_reason IS NOT NULL)
    OR
    (source_type = 'purchase' AND grant_reason IS NULL)
  )
);

CREATE UNIQUE INDEX ${TABLE_PREFIX}credit_lots_stripe_session_uidx
  ON ${TABLE_PREFIX}credit_lots (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

CREATE UNIQUE INDEX ${TABLE_PREFIX}credit_lots_signup_grant_uidx
  ON ${TABLE_PREFIX}credit_lots (user_id, grant_reason)
  WHERE grant_reason IS NOT NULL;

CREATE INDEX ${TABLE_PREFIX}credit_lots_fifo_spend_idx
  ON ${TABLE_PREFIX}credit_lots (user_id, expires_at, created_at, id)
  WHERE remaining_millicredits > 0;

CREATE INDEX ${TABLE_PREFIX}credit_lots_user_created_idx
  ON ${TABLE_PREFIX}credit_lots (user_id, created_at, id);

CREATE TABLE ${TABLE_PREFIX}credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_type ${TABLE_PREFIX}credit_transaction_type NOT NULL,
  amount_millicredits bigint NOT NULL,
  lot_id uuid NULL REFERENCES ${TABLE_PREFIX}credit_lots(id) ON DELETE SET NULL,
  consumption_group_id uuid NULL,
  usage_event_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT ${TABLE_PREFIX}credit_transactions_non_zero_amount CHECK (
    amount_millicredits <> 0
  ),
  CONSTRAINT ${TABLE_PREFIX}credit_transactions_consumption_group_required CHECK (
    (
      transaction_type = 'consumption'
      AND consumption_group_id IS NOT NULL
      AND usage_event_id IS NOT NULL
      AND lot_id IS NOT NULL
      AND amount_millicredits < 0
    )
    OR
    (
      transaction_type <> 'consumption'
      AND consumption_group_id IS NULL
    )
  )
);

CREATE INDEX ${TABLE_PREFIX}credit_transactions_user_created_idx
  ON ${TABLE_PREFIX}credit_transactions (user_id, created_at DESC, id DESC);

CREATE INDEX ${TABLE_PREFIX}credit_transactions_group_idx
  ON ${TABLE_PREFIX}credit_transactions (consumption_group_id)
  WHERE consumption_group_id IS NOT NULL;

CREATE INDEX ${TABLE_PREFIX}credit_transactions_usage_event_idx
  ON ${TABLE_PREFIX}credit_transactions (usage_event_id)
  WHERE usage_event_id IS NOT NULL;

CREATE OR REPLACE VIEW ${TABLE_PREFIX}credit_balances AS
SELECT
  user_id,
  COALESCE(SUM(remaining_millicredits), 0) AS total_balance_millicredits,
  COALESCE(SUM(remaining_millicredits) FILTER (
    WHERE expires_at IS NOT NULL
      AND expires_at > NOW()
      AND remaining_millicredits > 0
  ), 0) AS promotional_balance_millicredits,
  COALESCE(SUM(remaining_millicredits) FILTER (
    WHERE expires_at IS NULL
      AND remaining_millicredits > 0
  ), 0) AS purchased_balance_millicredits,
  COALESCE(SUM(-remaining_millicredits) FILTER (
    WHERE remaining_millicredits < 0
  ), 0) AS debt_balance_millicredits
FROM ${TABLE_PREFIX}credit_lots
WHERE expires_at IS NULL
   OR expires_at > NOW()
   OR remaining_millicredits < 0
GROUP BY user_id;

CREATE OR REPLACE FUNCTION ${TABLE_PREFIX}consume_credit_lots_fifo(
  p_user_id uuid,
  p_amount_millicredits bigint,
  p_consumption_group_id uuid,
  p_usage_event_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(lot_id uuid, amount_millicredits bigint)
LANGUAGE plpgsql
AS $$$$
DECLARE
  v_remaining bigint;
  v_lot RECORD;
  v_consumed bigint;
  v_anchor_lot_id uuid;
BEGIN
  -- Prevent TOCTOU race: two concurrent calls with the same consumption_group_id
  -- could both pass the EXISTS idempotency check before either inserts. The advisory
  -- lock serializes callers per consumption_group_id within the transaction.
  PERFORM pg_advisory_xact_lock(hashtext(p_consumption_group_id::text));

  IF p_amount_millicredits <= 0 THEN
    RAISE EXCEPTION 'p_amount_millicredits must be greater than zero'
      USING HINT = '${TABLE_PREFIX}invalid_credit_amount';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ${TABLE_PREFIX}credit_transactions
    WHERE consumption_group_id = p_consumption_group_id
  ) THEN
    RETURN;
  END IF;

  v_remaining := p_amount_millicredits;

  FOR v_lot IN
    SELECT id, remaining_millicredits
    FROM ${TABLE_PREFIX}credit_lots
    WHERE user_id = p_user_id
      AND remaining_millicredits > 0
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY
      CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,
      expires_at,
      created_at,
      id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining = 0;

    v_anchor_lot_id := v_lot.id;
    v_consumed := LEAST(v_remaining, v_lot.remaining_millicredits);

    UPDATE ${TABLE_PREFIX}credit_lots
    SET remaining_millicredits = remaining_millicredits - v_consumed
    WHERE id = v_lot.id;

    INSERT INTO ${TABLE_PREFIX}credit_transactions (
      id,
      user_id,
      transaction_type,
      amount_millicredits,
      lot_id,
      consumption_group_id,
      usage_event_id,
      metadata,
      created_at
    ) VALUES (
      gen_random_uuid(),
      p_user_id,
      'consumption',
      -v_consumed,
      v_lot.id,
      p_consumption_group_id,
      p_usage_event_id,
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('lot_id', v_lot.id),
      NOW()
    );

    lot_id := v_lot.id;
    amount_millicredits := v_consumed;
    RETURN NEXT;

    v_remaining := v_remaining - v_consumed;
  END LOOP;

  IF v_remaining > 0 THEN
    IF v_anchor_lot_id IS NULL THEN
      SELECT id
      INTO v_anchor_lot_id
      FROM ${TABLE_PREFIX}credit_lots
      WHERE user_id = p_user_id
      ORDER BY
        CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,
        expires_at,
        created_at,
        id
      FOR UPDATE
      LIMIT 1;
    END IF;

    IF v_anchor_lot_id IS NULL THEN
      RAISE EXCEPTION 'cannot anchor negative balance for user %s because no credit lot exists', p_user_id
        USING HINT = '${TABLE_PREFIX}credit_anchor_missing';
    END IF;

    UPDATE ${TABLE_PREFIX}credit_lots
    SET remaining_millicredits = remaining_millicredits - v_remaining
    WHERE id = v_anchor_lot_id;

    INSERT INTO ${TABLE_PREFIX}credit_transactions (
      id,
      user_id,
      transaction_type,
      amount_millicredits,
      lot_id,
      consumption_group_id,
      usage_event_id,
      metadata,
      created_at
    ) VALUES (
      gen_random_uuid(),
      p_user_id,
      'consumption',
      -v_remaining,
      v_anchor_lot_id,
      p_consumption_group_id,
      p_usage_event_id,
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'lot_id', v_anchor_lot_id,
        'overspend', true
      ),
      NOW()
    );

    lot_id := v_anchor_lot_id;
    amount_millicredits := v_remaining;
    RETURN NEXT;
  END IF;

  RETURN;
END;
$$$$;
-- +goose StatementEnd
-- +goose Down
-- +goose ENVSUB ON
-- +goose StatementBegin
DROP FUNCTION IF EXISTS ${TABLE_PREFIX}consume_credit_lots_fifo(uuid, bigint, uuid, text, jsonb);
DROP VIEW IF EXISTS ${TABLE_PREFIX}credit_balances;

DROP INDEX IF EXISTS ${TABLE_PREFIX}credit_transactions_usage_event_idx;
DROP INDEX IF EXISTS ${TABLE_PREFIX}credit_transactions_group_idx;
DROP INDEX IF EXISTS ${TABLE_PREFIX}credit_transactions_user_created_idx;
DROP TABLE IF EXISTS ${TABLE_PREFIX}credit_transactions;

DROP INDEX IF EXISTS ${TABLE_PREFIX}credit_lots_user_created_idx;
DROP INDEX IF EXISTS ${TABLE_PREFIX}credit_lots_fifo_spend_idx;
DROP INDEX IF EXISTS ${TABLE_PREFIX}credit_lots_signup_grant_uidx;
DROP INDEX IF EXISTS ${TABLE_PREFIX}credit_lots_stripe_session_uidx;
DROP TABLE IF EXISTS ${TABLE_PREFIX}credit_lots;

DROP TYPE IF EXISTS ${TABLE_PREFIX}credit_transaction_type;
DROP TYPE IF EXISTS ${TABLE_PREFIX}credit_source_type;
-- +goose StatementEnd
