---
detail: minimal
audience: developer
---

# Billing

Prepaid credit wallet. No subscriptions at v1. Credits are the single billing currency across all AI features.

## Docs

| Doc | Purpose |
|-----|---------|
| [credit-ledger.md](./credit-ledger.md) | Schema, FIFO deduction, cost calculation, migration SQL |
| [settlement.md](./settlement.md) | Admission gates, settlement modes, reconciliation, SSE events |
| [stripe-integration.md](./stripe-integration.md) | Checkout, webhooks, signup grants |
| [api-contracts.md](./api-contracts.md) | HTTP endpoints, error shapes |

## Credit Packs

| Pack ID | Label | Price | Credits | Bonus |
|---------|-------|-------|---------|-------|
| `starter` | Starter | $5 | 500 | - |
| `writer` | Writer | $10 | 1,100 | 10% |
| `studio` | Studio | $25 | 3,000 | 20% |

Backend owns the catalog. Frontend never sends raw dollar or credit amounts to Stripe.

## Free Tier

- New signups: 300 free credits, expire after 30 days
- Free tier: standard models only
- Core writing features: always free; only AI features consume credits

## Model Tiers

| Tier | Models | Markup | Access |
|------|--------|--------|--------|
| Standard | Haiku, GPT-4o-mini | ~20% | Free + paid |
| Premium | Sonnet, GPT-4o | ~25% | Paid only |
| Frontier | Opus, o3, deep reasoning | ~25% | Paid only |

Model cost drift is absorbed by changing the pricing table, not pack definitions.

## Anti-Abuse

- Max concurrent billable streams per user: 3
- Model-tier allowlists by plan
- Signup bonus: one grant reason per user
- Webhook idempotency by Stripe session id

## UX Notes

- Status bar: compact credit balance
- Billing page: purchased vs promotional balance, usage history (model/tokens/charge per step)
- Pre-action estimate shown before expensive actions; server charges exact post-step usage
- Exhausted credits: show non-blocking state, keep partial streamed output visible, render purchase CTA routing to `/settings/billing`

## Non-Goals (v1)

- No Stripe subscriptions
- No Stripe Meters
- No automatic refund or chargeback reversal
- No client-authoritative balance calculations

`refund` transaction type is reserved in the schema for future use.

## Future Upgrade Path

1. Subscriptions with monthly included credits
2. Auto top-up
3. Team shared pools and budgets
4. Outcome-priced premium workflows
