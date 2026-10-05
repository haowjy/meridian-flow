# Gateway

## Port, routing, and attempt policy

Normalizes Anthropic, OpenAI, and OpenAI-compatible providers behind a single
streaming `Gateway` port.

| Concern | Detail |
|---|---|
| `Gateway` port | `stream(request) -> AsyncIterable<StreamEvent>`, `generate(request) -> GenerateResult`, optional `settleCancelledResult()` and `listModels()` |
| `ProviderAdapter` port | per-provider streaming implementation (Anthropic, OpenAI Responses, OpenAI-compatible) |
| Routing | `ProviderRegistry` maps model IDs to adapters; `resolveRoute` picks adapter + model for a request |
| Retry/fallback | Exponential backoff honors provider `retry-after-ms` / `retry-after` hints (capped at 60s) and `x-should-retry: false`; its wait is abort-aware. Ordered fallback and retry happen only before **committed** output has been emitted. Committed output is visible text or a tool call; reasoning deltas and usage are process-only, so a reasoning-only abort is retryable. The gateway is the only retry layer: provider SDK clients run with `maxRetries: 0`, so one gateway attempt is one HTTP request |
| Stream timing | `attempt-stream.ts` starts one monotonic clock per adapter attempt and eagerly stamps canonical events on arrival into a byte-bounded buffer, so downstream journal writes do not distort timing. A successful result carries `timing: { latencyMs, timeToFirstTokenMs, generationMs }`: provider-attempt invocation to stream-end arrival, attempt invocation to first nonempty text/reasoning/tool-argument delta, and first output arrival to stream-end arrival. If the pump waits on the consumer, generation duration is null; latency and TTFT are retained only when their endpoint events were stamped before that wait. Both TTFT and generation duration are null when no such delta arrives; `custom.delta` is not writer output. Retry timing resets for each attempt, and the successful attempt's values are persisted. |
| Deadline | per attempt, two timers on one derived `AbortSignal`: an inactivity (stall) timer re-armed by every stream event (`GatewayConfig.attemptStallMs`, env `MODEL_CALL_STALL_MS`, default 60s; never kills a slow-but-streaming model) and an absolute ceiling backstop (`GatewayConfig.attemptCeilingMs`, env `MODEL_CALL_TIMEOUT_MS`, default 15 min / 900s, 0 disables). Per-model `stallTimeoutMs`/`ceilingTimeoutMs` override the gateway values. Retry/deadline driver lives in `attempt-stream.ts`; the signal lives in `deadline.ts` |
| Cancel drain | After partial output, a parent cancel may drain usage/end events, but one absolute five-second deadline from abort bounds that drain even after a rejected read. `attempt-stream.ts` owns one abort listener per attempt and clears its timer/listener on exit; iterator `return()` is observed without awaiting it, so a hostile adapter cannot hold cancellation or retry hostage. |
| Config | `GatewayConfig` with provider list, default model, retry/fallback/`attemptStallMs`/`attemptCeilingMs` policy; `createGatewayFromEnv` for env-driven setup |
| Registry | `MODEL_REGISTRY` in `config/registry.ts` is the single source for each model's config, pinned pricing, cache descriptor, and required tokenizer family. `buildFromRegistry` composes providers. |
| Collision warning | `onWarning` callback on registry construction warns on duplicate model IDs instead of letting the last writer win silently. |
| Usage normalization | Adapters own the conversion into canonical `Usage` and call `assertValidUsage` before returning. Providers disagree on what `inputTokens` counts: OpenAI reports an inclusive total, Anthropic reports uncached input and each cache counter as separate additive categories. An adapter that passes additive counters through unchanged underbills every cached turn — see issue [#356](https://github.com/haowjy/meridian-flow/issues/356). |
| OpenRouter | `openrouter` adapter reuses the OpenAI-compatible wire shape and owns provider-reported cost enrichment via `/generation`. |
| Cancel settlement | `Gateway.settleCancelledResult()` owns interrupted-call reconciliation and persist decisions. Generic token/missing-usage handling lives in `gateway/domain/cancel-settlement.ts`; OpenRouter-specific `/generation` settlement lives under `gateway/adapters/openrouter/`. The loop only asks the gateway to settle and then finalizes cancellation. |
| Tool-arg JSON repair | `gateway/helpers/parse-tool-arguments.ts` repairs malformed provider JSON (e.g. unquoted hex hash `"in": 6c4a`) via `jsonrepair` before falling back to a typed `ToolArgsParseError` sentinel. Unrepairable input surfaces a clear model-actionable parse error instead of degrading into misleading downstream schema errors. See issue [#113](https://github.com/haowjy/meridian-flow/issues/113). |
| Instrumentation | `instrumented-gateway.ts` decorates the `Gateway` port once in `createProductionAppPorts` (`lib/compose.ts`), emitting `gateway`-source lifecycle events (`stream.open`/`retry`/`close`; per-chunk only under `OBS_VERBOSE=gateway.chunks`, dev/test-only) keyed by `correlation.gatewayCallId`. Close logs distinguish `gatewayObservationDurationMs` (includes downstream consumption) from provider timing carried by the attempt result. Provider SDK retries are disabled; `attempt-stream.ts` owns retry policy. A `Gateway` constructed outside that seam bypasses lifecycle instrumentation — intentional for tests, wrong for production consumers. Verbosity is resolved from the injected environment at that seam (`resolveObsVerbose({ rawNodeEnv, obsVerbose })` in `lib/compose.ts`), not a module-level `process.env` read — tests inject `OBS_VERBOSE`; a module-level const would bypass them. |
| Model-request inspection | Immediately before `Gateway.stream()`, the orchestrator offers the provider-neutral `GenerateRequest` to a capture port. Disabled capture does not serialize it. Local dev/test capture shares `gatewayCallId` with lifecycle events and retains at most 200 records, 2 MiB per request, and 16 MiB total; exact-call reads include the preceding request for prefix comparison. The shared `APP_DEBUG` gate can enable capture outside production, and content never enters `EventSink`, thread snapshots, the event journal, or JSONL. |

Canonical gateway types live in `gateway/domain/types.ts`.

**A terminal outcome needs causal evidence.** The instrumented `stream.close`
`outcome` is `ok`, `error`, or `cancelled`. A failure becomes `cancelled` only
with causal abort evidence: the thrown error is `signal.reason` or an
`AbortError`. Message text alone (`"Aborted"`, `"Request aborted"`) is not
evidence: a provider failing independently after an abort stays `error`, and
`sleep` and cancel paths reject with `signal.reason` (or a synthesized
`AbortError`) so their failures carry identity. A thrown error's string
`.code` populates both the `stream.close` payload `errorCode` and
`correlation.errorCode`.

## Cache descriptors

`config/registry.ts` is the source of truth for each model's prompt cache behavior. Every `RegisteredModel` has `promptCache: { kind, ttlMs }`; `buildFromRegistry` carries it into `ModelInfo` so assembly and adapters use one declaration.

| Models | Descriptor | Reason |
|---|---|---|
| Anthropic and OpenRouter Claude | `explicit`, 1 hour | Flow places canonical breakpoints. Anthropic and OpenRouter translate them to their explicit `cache_control` wire format. |
| OpenAI Responses | `automatic`, 5 minutes | OpenAI caches supported model prefixes automatically. Five minutes is a conservative estimate for the currently registered models' in-memory cache. |
| DeepSeek V4 Flash | `automatic`, 1 hour | DeepSeek documents automatic context caching; the one-hour TTL is a conservative estimate against the documented usual retention of hours to days. DeepSeek's Anthropic-compatible endpoint ignores explicit `cache_control`, so it must not receive Flow's explicit marks. |
| Non-Anthropic OpenRouter | `none`, unknown TTL | No cache behavior is declared for these routed models. |

The registry validates every `explicit` model's TTL as five minutes or one hour when loaded, before any request reaches an adapter. The Anthropic and OpenAI-compatible request mappers translate descriptor TTLs to provider wire format. Only explicit models are marked during loop assembly; automatic models receive no marks, and none models are always predicted cold. Cache-write pricing must match the descriptor TTL tier: five-minute writes are 1.25× input, one-hour writes are 2× input. A nullable TTL is unknown, not infinite: the read model predicts cold when it cannot establish a freshness window.

## Pricing tiers

`ModelPricing.inputTierTokens` is the input size above which a provider reprices the whole request. The registry rejects a tier that is not positive or not below the context window. It flows to `ModelInfo`, and the runtime's default compaction trigger compacts before crossing it. No registered model sets one: every current model bills flat. Set it when registering a tiered model (GPT-6 Astra at 272k, Gemini 3.1 Pro at 200k).

## Tokenizer family

Every `RegisteredModel` declares a required `tokenizer` family (`anthropic`,
`o200k`, `gemini`, or `deepseek`), carried onto `ModelInfo`. OpenRouter
entries declare the family of the model they route to. The runtime's
compaction estimator keys its CJK rate on this family and has no fallback. A
family that undercounts the model lets a Chinese-heavy request cross the
compaction trigger and price tier unseen; one that overcounts compacts early.
Rates and their evidence live in the [runtime compaction context](../../.context/compaction.md).

## Provider errors

`adapters/provider-http-error.ts` owns one HTTP-status policy for every adapter
(the OpenAI Responses, Chat Completions, and OpenRouter adapters share
`openai-compatible/errors.ts`). Network failures, failures with no response,
408, 429, and 5xx retry. 401/403 are `auth_error`; 400 is `invalid_request`,
`context_overflow`, or `content_filtered`. Every other 4xx, including 402 out
of balance, is `provider_error` with `retryable: false`: the provider refused
this request and will refuse it again. There is no separate code for an
exhausted account. `x-should-retry: false` still overrides.

An error event carries `providerResponse: { status, message, body }` when the
provider answered. SDK clients are built with `providerFetch`, which keeps a
failed response's body text (capped at 4 KiB) keyed by the `Headers` object the
SDK error carries, because SDKs keep only part of a parsed body. Without it the
body falls back to the SDK's parsed view. `stream.close` logs only
`providerStatus`, in its correlation beside `errorCode`. The runtime puts status and message on the failed reply's
metadata and the body on the dev capture record; see
[Provider Failures](../../../../../../../docs/debugging.md#provider-failures).

## Context-window errors

Every adapter normalizes a provider's context-window rejection to the one provider-neutral code `context_overflow`, non-retryable. Anthropic's `model_context_window_exceeded` stop reason is missing from the SDK union, so `anthropic/stream-collect.ts` matches the wire string and emits the error with the metered partial result; OpenAI Responses maps `context_length_exceeded`; the HTTP error mappers match context-length messages, not any message containing "token". The error event's `result` carries metered usage so the loop can bill it. The runtime turns `context_overflow` into one cold compaction and one retry per reply. With provider fallback enabled, the router yields a non-retryable error at once and only a retryable error moves to the next provider. A router that drops a non-retryable error ends the stream with no terminal event, and the loop never sees the overflow.

## DeepSeek cache evidence

DeepSeek evidence for the automatic classification: its [context-caching guide](https://api-docs.deepseek.com/guides/kv_cache/) says caching is enabled by default and reports cache-hit counters; its [Anthropic compatibility guide](https://api-docs.deepseek.com/guides/anthropic_api/) documents the configured `/anthropic` endpoint and says `cache_control` is ignored. In the dev database, `model_responses` had 31 `deepseek-v4-flash` rows, 29 with positive `cache_read_tokens` (188,416 total). The Anthropic adapter's `mapUsage` reads `cache_read_input_tokens`; those persisted counters confirm the deployed compatibility path exposes cache reads through our existing mapping.

## Output limits

Meridian sets no output limits of its own. Provider defaults apply. Branch
summaries preserve the source request's `maxTokens` or its absence. Rolling
summaries and handoff briefs send no `maxTokens`. Anthropic requires
`max_tokens`, so its adapter sends
`request.maxTokens ?? maxOutputTokens` from the registry. OpenAI sends
`max_output_tokens` only when set. OpenAI-compatible requests leave
`max_tokens` undefined so the provider default applies.

The registry's `maxOutputTokens` also reserves reply room when auto-compaction
computes the usable input window: `contextWindow` minus `maxOutputTokens` and
the other reserves. This value mirrors the provider default rather than
defining a lower Meridian limit. It is 65,536 for DeepSeek V4 Flash and 64,000
for both Claude Sonnet 4 entries.

Output limits are not cache keys. Anthropic's thinking budget does affect the
cache, so implicit effort budgets resolve against the model's output budget,
not a per-call limit. To satisfy `budget_tokens < max_tokens`, an implicit
budget is clamped to one below the call's `maxTokens`.

DeepSeek V4 Flash declares a 1,048,576-token window. A live Anthropic-compatible
call accepted 150,013 input tokens (253 uncached plus 149,760 cached) on
2026-09-27; a separate 300,013-token call also succeeded. Prices remain tracked
separately in issue #613.
