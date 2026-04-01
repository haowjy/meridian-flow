---
detail: comprehensive
audience: developer
---

# Credit Ledger

Core ledger model, schema, cost calculation, and migration SQL.

## Credit Unit

- 1 credit = $0.01 of compute at Meridian pricing
- Internally: all balances and charges use **millicredits** (integer)
- 1 credit = 1,000 millicredits = $0.01
- 1 millicredit = $0.00001
- UI displays credits; ledger never rounds to whole credits

## Data Model

```text
credit_lots
├── id: uuid
├── user_id: uuid
├── source_type: enum (purchase, grant)
├── original_amount_millicredits: bigint
├── remaining_millicredits: bigint      -- may go negative (debt anchor)
├── expires_at: timestamptz NULL        -- NULL = never expires (purchased)
├── stripe_session_id: text NULL UNIQUE WHERE NOT NULL
├── grant_reason: text NULL             -- stable machine value, e.g. "signup_bonus_v1"
├── metadata: jsonb NOT NULL DEFAULT '{}'
└── created_at: timestamptz

credit_transactions  -- append-only audit history
├── id: uuid
├── user_id: uuid
├── transaction_type: enum (purchase, grant, consumption, expiration, refund)
├── amount_millicredits: bigint         -- negative for consumption/expiration
├── lot_id: uuid NULL
├── consumption_group_id: uuid NULL     -- groups all lot rows for one billable step
├── usage_event_id: text NULL           -- e.g. "turn_id:request_index"
├── metadata: jsonb NOT NULL DEFAULT '{}'
└── created_at: timestamptz

credit_balances  -- view over credit_lots
├── user_id
├── total_balance_millicredits
├── promotional_balance_millicredits
├── purchased_balance_millicredits
└── debt_balance_millicredits
```

Key constraints and indexes:

- `UNIQUE (stripe_session_id) WHERE stripe_session_id IS NOT NULL`
- `UNIQUE (user_id, grant_reason) WHERE grant_reason IS NOT NULL` — one grant per reason per user
- `INDEX (user_id, expires_at, created_at) WHERE remaining_millicredits > 0` — FIFO spend path
- No `CHECK (remaining_millicredits >= 0)` — negative remaining is intentional (debt anchor)
- `INDEX (consumption_group_id) WHERE consumption_group_id IS NOT NULL`
- `INDEX (usage_event_id) WHERE usage_event_id IS NOT NULL`

### Balance View

Filters expired positive lots; keeps negative rows regardless of `expires_at` (debt stays visible):

```sql
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
```

## Go Interfaces

```go
package billing

type CreditService interface {
    GetBalance(ctx context.Context, userID string) (*CreditBalance, error)
    ListCreditPacks(ctx context.Context) ([]CreditPack, error)
    ListTransactions(ctx context.Context, userID string, req ListTransactionsRequest) (*CreditTransactionPage, error)
    CreateCheckoutSession(ctx context.Context, userID string, req CreateCheckoutSessionRequest) (*CheckoutSession, error)
    HandleStripeWebhook(ctx context.Context, req StripeWebhookRequest) error
}

type CreditGranter interface {
    InitializeSignupCredits(ctx context.Context, req InitializeSignupCreditsRequest) (*InitializeSignupCreditsResult, error)
}

type InitializeSignupCreditsRequest struct {
    UserID        string
    Email         string
    AuthProvider  string // "google", "github", "email"
    EmailVerified bool
}

type InitializeSignupCreditsResult struct {
    CreditsGranted                int64
    AlreadyInitialized            bool
    PromotionalBalanceMillicredits int64
    PurchasedBalanceMillicredits   int64
    TotalBalanceMillicredits       int64
}

type CreditStore interface {
    GetBalance(ctx context.Context, userID string) (*CreditBalance, error)
    ListTransactions(ctx context.Context, userID string, req ListTransactionsRequest) (*CreditTransactionPage, error)
    CreatePurchaseLot(ctx context.Context, req CreatePurchaseLotRequest) error
    CreateGrantLot(ctx context.Context, req CreateGrantLotRequest) error
    ConsumeFIFO(ctx context.Context, req ConsumeFIFORequest) error
    ExpireAvailableLots(ctx context.Context, nowUTC string, batchSize int) ([]ExpiredLot, error)
}
```

Interfaces live in `internal/domain/` — services consume them, repositories implement them.

## Cost Calculation

`CalculateCreditCost` is a pure domain function. No floats, no DB access.

```go
type TokenUsage struct {
    InputTokens     int64
    OutputTokens    int64
    ReasoningTokens int64
    CachedTokens    int64
}

type ModelPricing struct {
    InputMicrousdPer1K     int64
    OutputMicrousdPer1K    int64
    ReasoningMicrousdPer1K int64
    CachedMicrousdPer1K    int64
    MarkupBasisPoints      int64
}

func CalculateCreditCost(pricing ModelPricing, usage TokenUsage) int64 {
    rawMicrousd :=
        ceilDiv(usage.InputTokens*pricing.InputMicrousdPer1K, 1000) +
        ceilDiv(usage.OutputTokens*pricing.OutputMicrousdPer1K, 1000) +
        ceilDiv(usage.ReasoningTokens*pricing.ReasoningMicrousdPer1K, 1000) +
        ceilDiv(usage.CachedTokens*pricing.CachedMicrousdPer1K, 1000)

    markedMicrousd := ceilDiv(rawMicrousd*(10_000+pricing.MarkupBasisPoints), 10_000)

    // 1 millicredit = 10 microusd
    // (1 credit = $0.01 = 10_000 microusd = 1_000 millicredits)
    millicredits := ceilDiv(markedMicrousd, 10)

    if millicredits < 1 {
        return 1
    }
    return millicredits
}

func ceilDiv(numerator, denominator int64) int64 {
    return (numerator + denominator - 1) / denominator
}
```

Rules: integer math end-to-end, every division rounds up, minimum charge is 1 millicredit.

### Model Pricing Registry (launch-day)

```go
var DefaultModelPricing = map[string]ModelPricing{
    "claude-sonnet-4-20250514": {
        InputMicrousdPer1K: 3000, OutputMicrousdPer1K: 15000,
        ReasoningMicrousdPer1K: 15000, CachedMicrousdPer1K: 1500,
        MarkupBasisPoints: 2500,
    },
    "claude-haiku-4-5-20251001": {
        InputMicrousdPer1K: 800, OutputMicrousdPer1K: 4000,
        ReasoningMicrousdPer1K: 4000, CachedMicrousdPer1K: 400,
        MarkupBasisPoints: 2000,
    },
    "claude-opus-4-20250515": {
        InputMicrousdPer1K: 15000, OutputMicrousdPer1K: 75000,
        ReasoningMicrousdPer1K: 75000, CachedMicrousdPer1K: 7500,
        MarkupBasisPoints: 2500,
    },
    "gpt-4o": {
        InputMicrousdPer1K: 2500, OutputMicrousdPer1K: 10000,
        ReasoningMicrousdPer1K: 10000, CachedMicrousdPer1K: 1250,
        MarkupBasisPoints: 2500,
    },
    "gpt-4o-mini": {
        InputMicrousdPer1K: 150, OutputMicrousdPer1K: 600,
        ReasoningMicrousdPer1K: 600, CachedMicrousdPer1K: 75,
        MarkupBasisPoints: 2000,
    },
}
```

Prices are approximate and will be tuned. Loaded from config in production; hardcoded defaults for development.

## FIFO Deduction

One PostgreSQL function locks rows, updates lots, and writes audit rows atomically. The Go repository calls this function — it does not assemble FIFO with multiple ad hoc updates.

Key behaviors:
- `FOR UPDATE` prevents concurrent consumers from spending the same lot balance
- `(expires_at IS NULL OR expires_at > NOW())` prevents consuming expired lots even if cron has not run yet
- Advisory lock on `consumption_group_id` prevents TOCTOU race on the idempotency check
- `consumption_group_id` makes a multi-lot deduction queryable as one logical usage event
- Idempotent: short-circuits if that group already exists in `credit_transactions`
- If concurrent in-flight requests drain the wallet, the final FIFO lot becomes the debt anchor (goes negative instead of raising insufficiency)

See full function in [Migration SQL](#migration-sql) below.

## Audit Trail

One billable step can consume many lots. Both ids are required for auditability:

- `usage_event_id`: identifies the logical billable step (e.g. `turn_id:request_index`)
- `consumption_group_id`: identifies the exact settlement batch (`uuid_v5(billing_namespace, usage_event_id)`)

Example: request index 2 costs 6,500 millicredits, consumed from two lots:
- 1 transaction row for `-2000` against promotional lot
- 1 transaction row for `-4500` against purchased lot
- both rows share the same `consumption_group_id`

## Generation Record Integration

Existing generation records (in `turns.response_metadata`) are the durable receipt for exact billable usage. Add these fields as JSON keys (no schema migration needed):

| Field | Purpose |
|-------|---------|
| `billing_usage_event_id` | Deterministic id for the billable step |
| `billing_consumption_group_id` | Settlement batch id |
| `billing_amount_millicredits` | Fixed at first authoritative settlement; reused by reconciliation |
| `billing_status` | `pending` / `settled` / `failed` |
| `billing_last_error` | Last error if pending/failed |

`billing_status` semantics:
- `pending`: retryable failure; reconciliation will retry
- `settled`: FIFO deduction completed
- `failed`: exhausted retries (max 5 over 24h); monitoring alert fires, manual review required

## Expiration Cron

Atomic and race-safe with consumption. Consumption already filters expired lots, so correctness does not depend on cron timing.

```sql
WITH expired AS (
  SELECT id, user_id, remaining_millicredits
  FROM ${TABLE_PREFIX}credit_lots
  WHERE expires_at IS NOT NULL
    AND expires_at <= NOW()
    AND remaining_millicredits > 0
  FOR UPDATE SKIP LOCKED
),
updated AS (
  UPDATE ${TABLE_PREFIX}credit_lots l
  SET remaining_millicredits = 0
  FROM expired e
  WHERE l.id = e.id
  RETURNING e.id, e.user_id, e.remaining_millicredits
)
INSERT INTO ${TABLE_PREFIX}credit_transactions (
  id, user_id, transaction_type, amount_millicredits, lot_id, metadata, created_at
)
SELECT
  gen_random_uuid(),
  user_id,
  'expiration',
  -remaining_millicredits,
  id,
  '{}'::jsonb,
  NOW()
FROM updated;
```

## Migration SQL

Covers `credit_lots`, `credit_transactions`, `credit_balances`, and `consume_credit_lots_fifo`. Generation-record billing fields are a JSON shape change inside `turns.response_metadata` — no table migration needed.

### Up

```sql
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
AS $func$
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
    RAISE EXCEPTION '${TABLE_PREFIX}invalid_credit_amount'
      USING MESSAGE = 'p_amount_millicredits must be greater than zero';
  END IF;

  -- Idempotent retry path: if this group already settled, do nothing.
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

  -- Accepted v1 behavior:
  -- if concurrent in-flight requests already passed admission and drained the wallet,
  -- anchor the remainder on the final FIFO lot and allow that lot to go negative.
  IF v_remaining > 0 THEN
    IF v_anchor_lot_id IS NULL THEN
      SELECT id
      INTO v_anchor_lot_id
      FROM ${TABLE_PREFIX}credit_lots
      WHERE user_id = p_user_id
        AND (
          expires_at IS NULL
          OR expires_at > NOW()
          OR remaining_millicredits < 0
        )
      ORDER BY
        CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,
        expires_at,
        created_at,
        id
      FOR UPDATE
      LIMIT 1;
    END IF;

    IF v_anchor_lot_id IS NULL THEN
      RAISE EXCEPTION '${TABLE_PREFIX}credit_anchor_missing'
        USING MESSAGE = format(
          'cannot anchor negative balance for user %s because no credit lot exists',
          p_user_id
        );
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
$func$;
-- +goose StatementEnd
```

### Down

```sql
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
```
