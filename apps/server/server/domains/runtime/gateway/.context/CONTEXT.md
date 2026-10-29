# Gateway

The gateway normalizes Anthropic, OpenAI, and OpenAI-compatible providers behind
one streaming `Gateway` port. It owns routing, retry/deadline policy, usage
normalization, cancellation settlement, and provider-error mapping.

Provider keys are read only from `FLOW_`-prefixed variables
(`FLOW_ANTHROPIC_API_KEY`, `FLOW_DEEPSEEK_API_KEY`, …), never the vendors'
unprefixed names. The owner's machine sets the unprefixed keys for local
subscriptions, and Flow must not bill those. `check:negative-space` enforces the
prefix.

## Port and attempt policy

`Gateway.stream()` yields canonical `StreamEvent`s; `generate()`, optional
`settleCancelledResult()`, and `listModels()` complete the port. A registry maps
model IDs to provider adapters and is the single source for model context,
pricing, cache descriptor, and required tokenizer family. Duplicate model IDs
warn during construction rather than silently replacing an entry. Registry model
facts (limits, prices, modalities, effort ranges) come from
[models.dev](https://models.dev/api.json); a provider's API docs are only for what
models.dev lacks, such as per-TTL cache-write rates and wire parameters.

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
loop—own cache-counter conversion. Cancelled-call settlement is generic and
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

The dev mock selects a queued step, a built-in trigger, or its configured default,
then sends every normal response through `adapters/mock/response.ts`. Samples,
lorem, literal content and tool calls share JSON/SSE serialization, synthetic
byte-derived usage and cancellation-aware pacing. `MOCK_MODEL_RESPONSE` configures
tool-free defaults; `times` belongs only to the script queue. Deliberately malformed
or hanging transport probes stay separate. Controls and fixtures:
[debugging guide](../../../../../../../docs/debugging.md).

The compatible accumulator persists visible `reasoning_content` as a canonical
reasoning part before text and tools. This carries no provider signature or
replay metadata. Like text, it is included in the adapter's partial result on cancellation;
the runtime still discards the in-flight response on Stop. This does not change
the gateway's reasoning-only retry rule. The Chat Completions protocol does not
supply arbitrary block positions.

The mock reports request-derived synthetic input usage so long histories reach
real compaction boundaries. These counters test control flow, not provider
pricing or cache performance.

Malformed tool-argument JSON is repaired at the gateway helper or surfaced as a
typed parse refusal. Tool execution still validates the original Zod contract;
provider advertisement is not argument authority.

## Cache, limits, and persisted selections

Each model declares `promptCache: { kind, ttlMs, longTtlMs? }`: `ttlMs` is the
short lifetime, `longTtlMs` the longer one the model offers (Claude 1h; GPT-5.6+ 12h,
the shortest option of at least 1 hour, sent as `prompt_cache_options.ttl` via
`openaiCacheTtlWire`; the 30m default is never sent). DeepSeek and Gemini cache
automatically with an assumed 5-minute `ttlMs`.
`GenerateRequest.promptCacheRetention` is required and picks one
(`resolvePromptCacheTtlMs`): the loop asks `long` for primary threads and `short`
for subagents, fixed by thread kind so the cached prefix never varies mid-thread;
the rolling summarizer passes `short` explicitly. `validateModelRegistry` requires
`longTtlMs > ttlMs`; an OpenAI model with a `longTtlMs` must be 30m/12h, and an
explicit Anthropic-adapter model 5m/1h.
Explicit descriptors produce provider cache marks; automatic models receive no
marks and `none` models predict cold. DeepSeek is automatic with no TTL choice: its
descriptor holds one assumed 5-minute `ttlMs` for both chat kinds. A nullable TTL
means unknown, not infinite.

Claude and GPT-5.6+ bill cache writes by the TTL written. `Usage.cacheWriteLongTokens`
(Anthropic's `cache_creation.ephemeral_1h_input_tokens`; OpenAI's
`cache_write_tokens_details.ttl_12h_tokens`) is the long part of `cacheWriteTokens`;
pricing bills it at `cacheWriteLongUsdPerMillionTokens` (Claude 2x input, OpenAI 2.5x)
and the rest at `cacheWriteUsdPerMillionTokens` (the short rate: Claude 1.25x, OpenAI
1.25x). Providers that do not split writes use the single rate. `inputTierTokens`, when
present, must be positive and below the context window; the runtime uses it for
compaction planning, and with `aboveTierMultipliers` costing reprices a request whose
input exceeds it (OpenAI GPT-5.6+: whole request at 2x input and cache, 1.5x output
above 272K). Registry rates are pinned at standard prices; Gemini 4 Argon's intro
discount ends 2026-11-30 and the registry has no effective dates.

Gemini 4 Argon uses the `openai-compatible` adapter against Google's OpenAI endpoint;
an explicit effort goes out as `reasoning_effort` (Google maps it to `thinking_level`),
while `adaptive` and `disabled` send nothing. Each mapper lowers the effort to the registry
row's `maxReasoningEffort` (absent means `max`): Gemini's row says `high`; the GPT rows
accept every Flow level, so `max` goes out as `max`. Claude Opus 5.5 and
Fable 5.1 think adaptively and cannot disable it; nothing in Flow sends a disabled or
fixed-budget `thinking` for them (the loop sets no `reasoning`, and the summarizer's
`disabled` sends no `thinking` field).

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
Direct Anthropic rejects a root `oneOf` or `anyOf`, so its adapter advertises
one object envelope carrying each command's purpose, required and allowed
fields, and command-tagged descriptions generated from the Zod branches.
DeepSeek receives the canonical unions unchanged, and a root `allOf` is refused
at tool registration.

## LIVE_TEST_MODEL (dev only)

`LIVE_TEST_MODEL=<registry model id>` sends every gateway call to that model, whatever
the request, chat binding or Agent names. `createGatewayFromEnv` validates it (known id,
provider key set) and wraps the gateway once (`config/live-test-model.ts`); `startup-guards`
refuses it in production. The wrapper rewrites the request's model, drops its provider,
and answers every `listModels()` entry with the override's facts under the listed id,
because compaction, image support, tokenizer and cache prediction look models up by the
stored id. Costing needs no hook: it prices the provider and model the response reports.
Stored bindings, Agent files and the catalog still show the model they name. The name has
no `FLOW_` prefix because it is not a provider key.
