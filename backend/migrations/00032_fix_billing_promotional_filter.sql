-- +goose Up
-- +goose ENVSUB ON

CREATE OR REPLACE VIEW ${TABLE_PREFIX}credit_balances AS
SELECT
  user_id,
  COALESCE(SUM(remaining_millicredits), 0) AS total_balance_millicredits,
  COALESCE(SUM(remaining_millicredits) FILTER (
    WHERE source_type = 'grant'
      AND expires_at IS NOT NULL
      AND expires_at > NOW()
      AND remaining_millicredits > 0
  ), 0) AS promotional_balance_millicredits,
  COALESCE(SUM(remaining_millicredits) FILTER (
    WHERE source_type = 'purchase'
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

-- +goose Down
-- +goose ENVSUB ON

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
    WHERE source_type = 'purchase'
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
