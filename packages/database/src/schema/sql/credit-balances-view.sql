-- Compatibility path for the credit balance read model.
DROP VIEW IF EXISTS credit_balances;
CREATE OR REPLACE VIEW credit_balances AS
SELECT
  user_id,
  COALESCE(SUM(remaining_millicredits), 0) AS total_balance_millicredits,
  COALESCE(SUM(remaining_millicredits) FILTER (WHERE source_type = 'grant'), 0) AS grant_balance_millicredits,
  COALESCE(SUM(remaining_millicredits) FILTER (WHERE source_type = 'purchase'), 0) AS purchased_balance_millicredits,
  COALESCE(SUM(remaining_millicredits) FILTER (WHERE source_type = 'debt'), 0) AS debt_balance_millicredits
FROM credit_lots
WHERE expires_at IS NULL OR expires_at > NOW() OR source_type = 'debt'
GROUP BY user_id;
