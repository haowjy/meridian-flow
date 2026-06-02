CREATE OR REPLACE FUNCTION validate_purchase_lot_subscription()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_type != 'purchase' THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM user_subscriptions us
    WHERE us.user_id = NEW.user_id
      AND us.status IN ('active', 'trialing')
  ) THEN
    RAISE EXCEPTION 'purchase credit lots require an active subscription';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
