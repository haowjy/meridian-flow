# Gateway

The gateway normalizes Anthropic, OpenAI, and OpenAI-compatible providers behind
one streaming `Gateway` port. It owns routing, retry/deadline policy, usage
normalization, cancellation settlement, and provider-error mapping.

## Port and attempt policy

`Gateway.stream()` yields canonical `StreamEvent`s; `generate()`, optional
`settleCancelledResult()`, and `listModels()` complete the port. A registry maps
model IDs to provider adapters and is the single source for model context,
pricing, cache descriptor, and required tokenizer family. Duplicate model IDs
warn during construction rather than silently replacing an entry.

`attempt-stream.ts` is the only retry layer. Provider SDK retries are disabled.
Retry/fallback occurs only before committed text or tool output; reasoning-only
output is retryable. Backoff honors provider retry hints and is abort-aware.
Each attempt has an inactivity stall timer and an absolute ceiling timer on one
derived signal. Partial-output cancellation may drain usage/end events but is
bounded by the cancel-drain deadline; iterator cleanup cannot hold cancellation
hostage.

Instrumentation wraps the production-composed gateway once. It emits lifecycle
records keyed by `gatewayCallId`; request capture is a separate bounded debug
port and never enters EventSink, thread snapshots, journal rows, or JSONL.

## Canonicalization and errors

Adapters normalize provider usage into the shared `Usage` contract and validate
it before returning. Provider counters differ, so adapters—not billing or the
loop—own cache-counter conversion. OpenRouter-specific cost enrichment and
cancel settlement stay in its adapter; generic cancellation reconciliation is
owned by the gateway.

A close is `ok`, `error`, or `cancelled`. `cancelled` requires causal abort
evidence: the thrown error is the signal reason or an `AbortError`; message text
such as "Aborted" is insufficient. Error codes populate both provider-facing
close metadata and correlation fields.

One HTTP error policy handles all adapters: network/408/429/5xx retry; 401/403
map to `auth_error`; 400 matches shared `invalid_request`, `context_overflow`,
or `content_filtered` patterns; other 4xx are non-retryable provider errors.
`x-should-retry: false` wins. Context-window refusals normalize to
`context_overflow` with metered partial usage so the runtime can perform one
cold compaction retry.

Provider terminal failure/truncation takes precedence over accumulated tool calls:
OpenAI incomplete/failed responses and compatible length/content-filter finishes
never become successful tool-use just because a call was streamed earlier.

The dev mock reports request-derived synthetic input usage, so long histories
reach real compaction boundaries. These counters test control flow, not provider
pricing or cache performance.

Malformed tool-argument JSON is repaired at the gateway helper or surfaced as a
typed parse refusal. Tool execution still validates the original Zod contract;
provider advertisement is not argument authority.

## Cache, limits, and persisted selections

Each model declares `promptCache: { kind, ttlMs }`. Explicit descriptors produce
provider cache marks; automatic models receive no marks and `none` models predict
cold. A nullable TTL means unknown, not infinite. Cache-write pricing follows
the descriptor tier. `inputTierTokens`, when present, must be positive and below
the context window; the runtime uses it for compaction planning.

Every model declares a tokenizer family with no fallback; runtime compaction
uses it for CJK estimates. Output limits are provider defaults unless a request
sets one; adapters that require an explicit provider field use the registry
maximum. That maximum also reserves input room for compaction and is not a
lower Meridian per-call cap.

Thread Agent bindings retain their resolved model selection. A retired or
unregistered stored model fails route resolution before provider dispatch; no
local-data remapping or compatibility alias is allowed. Tool schema projection
for providers that reject root unions belongs to the adapter, while execution
validates the unchanged canonical schema.
