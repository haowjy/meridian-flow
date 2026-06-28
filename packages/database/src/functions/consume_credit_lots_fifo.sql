DROP FUNCTION IF EXISTS consume_credit_lots_fifo(UUID, BIGINT, UUID, TEXT, JSONB);

CREATE OR REPLACE FUNCTION consume_credit_lots_fifo(
  p_user_id UUID,
  p_amount BIGINT,
  p_consumption_group_id UUID,
  p_usage_event_id TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  remaining_balance BIGINT,
  went_negative BOOLEAN,
  consumption_group_id UUID
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
  v_consumption_group_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be a positive bigint';
  END IF;

  IF p_usage_event_id IS NULL OR btrim(p_usage_event_id) = '' THEN
    RAISE EXCEPTION 'p_usage_event_id is required for idempotent consumption';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('credit_fifo'),
    hashtext(p_user_id::text)
  );

  IF EXISTS (
    SELECT 1
    FROM credit_transactions
    WHERE usage_event_id = p_usage_event_id
      AND transaction_type = 'consumption'
  ) THEN
    SELECT ct.consumption_group_id
    INTO v_consumption_group_id
    FROM credit_transactions ct
    WHERE ct.usage_event_id = p_usage_event_id
      AND ct.transaction_type = 'consumption'
    LIMIT 1;

    SELECT COALESCE(cb.total_balance_millicredits, 0)
    INTO v_balance
    FROM credit_balances cb
    WHERE cb.user_id = p_user_id;

    RETURN QUERY SELECT
      COALESCE(v_balance, 0),
      COALESCE(v_balance, 0) < 0,
      v_consumption_group_id;
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
    COALESCE(v_balance, 0) < 0,
    p_consumption_group_id;
END;
$$;
