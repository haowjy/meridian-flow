# Billing Design: Prepaid Credit Wallet

## Model

Prepaid credit packs purchased via Stripe Checkout. No subscriptions at v1. Credits are the single billing currency across all AI features.

## Credit System

### Credit Unit
- 1 credit = $0.01 of compute (at Meridian rate, which includes ~20-25% markup over raw model cost)
- Markup covers infrastructure costs (Supabase, Railway, Vercel, WebSocket, storage)
- Credit abstraction decouples user-facing pricing from model cost fluctuations

### Credit Packs
| Pack | Price | Credits | Bonus |
|------|-------|---------|-------|
| Starter | $5 | 500 | — |
| Writer | $10 | 1,100 | 10% bonus |
| Studio | $25 | 3,000 | 20% bonus |

### Free Tier
- New signups receive 300 free credits (no card required)
- Free credits expire after 30 days
- Free tier has access to standard models only (not frontier/expensive)
- Core writing features (editor, explorer, file management) are always free — credits only gate AI features

### Credit Expiration
- Purchased credits do not expire
- Promotional/free credits expire (30 days)
- Consumption order: expiring credits first, then purchased credits (FIFO within each)

## Cost Mapping

### Per-Action Estimates (shown to user before execution)
- Rewrite paragraph (Sonnet): ~3 credits
- Generate chapter outline: ~8 credits
- Continuity check (long context): ~15 credits
- Quick suggestion: ~1 credit

### Model Tiers
| Tier | Models | Markup | Access |
|------|--------|--------|--------|
| Standard | Haiku, GPT-4o-mini, fast models | ~20% | Free + paid |
| Premium | Sonnet, GPT-4o | ~25% | Paid only |
| Frontier | Opus, o3, deep reasoning | ~25% | Paid only |

Model cost-per-token changes are absorbed by updating the credit conversion rate. Users see stable credit prices per action.

## User Controls

### Hard Cap
- Users set a monthly spend cap (default: unlimited for purchased credits)
- When credits hit zero, AI features pause — no surprise charges
- Clear "Credits exhausted" state with one-click purchase flow

### Transparency
- Pre-action cost estimate: "This will use ~3 credits (Sonnet)"
- Post-action receipt in usage log: model, tokens, credits consumed
- Balance always visible in status bar or account menu
- Burn-rate indicator: "At current pace, credits last ~12 days"

### Alerts
- Configurable alerts at balance thresholds (e.g., 100 credits remaining)
- Optional email notification when balance is low

## Architecture

### Schema

Two tables: `credit_lots` (source of truth for balances) and `credit_transactions` (audit log).

```
credit_lots (source of truth for balance)
├── id: uuid
├── user_id: uuid (FK)
├── type: enum (purchase, grant)
├── original_amount: integer
├── remaining: integer
├── expires_at: timestamptz (NULL = never expires)
├── stripe_session_id: text (UNIQUE, NULL for grants)
├── grant_reason: text (NULL for purchases — "signup_bonus", "promo")
├── created_at: timestamptz

credit_transactions (append-only audit log)
├── id: uuid
├── user_id: uuid (FK)
├── type: enum (purchase, consumption, grant, expiration, refund)
├── amount: integer (positive for additions, negative for consumption)
├── metadata: jsonb
│   ├── model, tokens_in, tokens_out (for consumption)
│   ├── action_type (for consumption — "rewrite", "outline", etc.)
│   ├── lot_id (which lot was consumed from)
│   └── thread_id, turn_id (for per-turn tracking)
├── created_at: timestamptz
└── project_id: uuid (nullable, for per-project usage tracking)

credit_balances (view over credit_lots)
├── user_id
├── total_balance: SUM(remaining)
├── promotional_balance: SUM(remaining) WHERE expires_at IS NOT NULL
├── purchased_balance: SUM(remaining) WHERE expires_at IS NULL
```

`credit_lots` is the balance source of truth. `credit_transactions` is the audit log. `credit_balances` is a view, not a separate table — always consistent, no sync needed.

### Stripe Integration

```
Purchase flow:
1. User clicks "Buy 500 credits" → frontend creates Checkout Session via backend
2. Stripe Checkout handles payment UI, card processing
3. Webhook: checkout.session.completed → backend adds credits to ledger
4. Frontend polls or receives WebSocket update → balance refreshes

No Stripe Meters, no subscriptions, no recurring billing at v1.
Stripe Meters + subscriptions are the upgrade path when we add subscription tiers.
```

### Credit Gate: Check-per-Inference-Step

Credit checks run at every inference boundary — before each LLM call in an agent loop. Negative balances are acceptable; a single inference step can't cost enough to matter.

```
Agent loop:
1. User sends message
2. Check balance > 0 → if not, return 402 "credits exhausted"
3. Run inference (LLM call)
4. Deduct actual token cost from ledger
5. If tool call → execute tool → goto 2 (check again before next inference)
6. If final response → done

Concurrent calls may push balance slightly negative. That's fine —
max exposure is one inference step (~1-15 credits, pennies).
New calls blocked once balance ≤ 0.
```

No reservations, no locks, no hold table. The balance check is a simple read, the deduction is an atomic ledger append. Concurrency is handled by accepting that the balance can go slightly negative rather than adding complexity to prevent it.

### FIFO Credit Consumption

Deductions consume credits in order: expiring credits first (by expiration date), then purchased credits. Implemented as:

```sql
-- Deduct N credits, consuming expiring lots first
WITH lots AS (
  SELECT id, remaining
  FROM credit_lots
  WHERE user_id = $1 AND remaining > 0
  ORDER BY expires_at NULLS LAST, created_at
)
-- Subtract from lots in order until N is consumed
```

A `credit_lots` table tracks each credit grant (purchase, promo, signup bonus) with `remaining` quantity. The `credit_balances` view sums `remaining` across all lots. Expiration cron zeroes out expired lots and logs an `expiration` transaction.

```
credit_lots
├── id: uuid
├── user_id: uuid (FK)
├── type: enum (purchase, grant)
├── original_amount: integer
├── remaining: integer
├── expires_at: timestamptz (NULL for purchased credits)
├── stripe_session_id: text (NULL for grants)
├── created_at: timestamptz

credit_balances (view)
├── user_id
├── total_balance: SUM(remaining) from credit_lots
├── promotional_balance: SUM(remaining) WHERE expires_at IS NOT NULL
├── purchased_balance: SUM(remaining) WHERE expires_at IS NULL
```

### Webhook Idempotency

Credit grants on `checkout.session.completed` are idempotent by Checkout Session ID:

```sql
INSERT INTO credit_lots (user_id, type, original_amount, remaining, stripe_session_id, ...)
VALUES ($1, 'purchase', $2, $2, $3, ...)
ON CONFLICT (stripe_session_id) DO NOTHING;
```

`stripe_session_id` has a UNIQUE constraint. Duplicate webhook deliveries are no-ops. The lot is only created once per Checkout Session, regardless of how many times Stripe retries the webhook.

### Expiration Cron

Runs daily. Zeroes out expired lots and logs transactions:

```sql
UPDATE credit_lots
SET remaining = 0
WHERE expires_at < NOW() AND remaining > 0
RETURNING id, user_id, remaining AS expired_amount;
-- For each: INSERT INTO credit_transactions (type='expiration', amount=-expired_amount, ...)
```

### Cost Calculation

```go
// Simplified credit cost calculation
func CalculateCreditCost(model string, tokensIn, tokensOut int) int {
    modelRate := GetModelRate(model) // cost per 1K tokens (input/output)
    rawCost := (tokensIn * modelRate.Input + tokensOut * modelRate.Output) / 1000
    markedUp := rawCost * (1 + MARKUP_RATE) // 20-25%
    credits := CentsToCredits(markedUp)     // 1 credit = $0.01
    return max(credits, 1)                  // minimum 1 credit per action
}
```

## UX

### Balance Display
- Status bar: compact credit count with icon
- Account menu: detailed balance (purchased vs promo), usage history
- Settings: monthly usage chart, top actions by cost

### Purchase Flow
- In-app modal or dedicated billing page
- Stripe Checkout (hosted) — minimal custom UI needed
- Post-purchase: immediate balance update, confirmation toast

### Empty State
- When credits run out: non-blocking banner on AI features
- "Your credits have run out. Buy more to continue using AI features."
- Core writing features (editor, explorer, file management) remain fully functional

### Pre-Action Estimate
- Before expensive operations, show: "This will use ~15 credits (Opus, long context). Continue?"
- Configurable: users can disable confirmation for actions under N credits

## Free Credit Grant Policy

Credit grant timing depends on signup method:

| Signup method | When credits are granted | Why |
|---------------|------------------------|-----|
| Google OAuth | Immediately on signup | Identity verified by Google, low abuse risk |
| Email/password | After email verification | Prevents throwaway email farming |

This resolves the tension between "first AI interaction within 2 minutes" (onboarding goal) and "verified email for free credits" (anti-abuse goal). Google OAuth users get the instant path. Email users verify first, then get credits — verification email should be fast enough to stay under 2 minutes.

## Anti-Abuse

- Rate limit AI requests per user (token bucket)
- Max concurrent generations: 3
- Anomaly detection for sudden usage spikes
- Free credits require identity verification (Google OAuth or email confirmation)
- One free grant per account (device fingerprint + email)

## Future Upgrade Path

When usage patterns are understood:
1. **Subscriptions** — monthly plan with included credits + PAYG overage (Stripe Meters + Credit Grants)
2. **Auto top-up** — "Automatically buy 500 credits when balance drops below 50"
3. **Team billing** — shared credit pool, per-member budgets, admin controls
4. **Outcome pricing** — fixed-price packages for high-value workflows ("Story Bible Audit: 50 credits")
