# domains/billing

Credit ledger and model-call pricing. Rates are single-sourced from the
gateway's `MODEL_REGISTRY` — billing imports pricing from the gateway, never
the reverse.

FIFO lot consumption with usage-event idempotency. Provider-reported cost
(OpenRouter) takes priority over pinned rates (direct providers).

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for ports, adapters, and
invariants.
