# Gateway

The gateway normalizes Anthropic, OpenAI, Gemini, and OpenAI-compatible providers behind
one streaming `Gateway` port. It owns routing, retry/deadline policy, usage
normalization, cancellation settlement, and provider-error mapping.

## Package boundary

`@meridian-flow/gateway` imports no workspace package and nothing under `apps/`, and reads
no environment variable itself: keys arrive in `ProviderConfig`, and every SDK client option
that would default from the environment is passed explicitly. The one exception is the SDKs'
own `ANTHROPIC_CUSTOM_HEADERS` and `OPENAI_CUSTOM_HEADERS`, which no client option turns off. Entries: `.` (the port, adapters,
domain types), `./shapes` (usage, provider error, JSON value: no Node built-ins and no SDKs, so
`@meridian/contracts` re-exports them into the browser bundle), `./mock-script` (the mock's zod
script schemas, the one definition `contracts/protocol` re-exports) and `./mock` (the mock server,
which needs `node:http`).

The server keeps what Meridian Flow chooses: `apps/server/server/lib/gateway/` holds the model
registry with its prices, the `FLOW_` env reading (`create-from-env.ts`), `LIVE_TEST_MODEL`, the retry
defaults and the observability decorator (`instrumented-gateway.ts`). The registry mixes provider
facts with what Flow offers and charges, so it stays whole there until a second consumer needs the
facts split out.

Provider keys are read only from `FLOW_`-prefixed variables
(`FLOW_ANTHROPIC_API_KEY`, `FLOW_DEEPSEEK_API_KEY`, …), never the vendors'
unprefixed names. The owner's machine sets the unprefixed keys for local
subscriptions, and Flow must not bill those. `check:negative-space` enforces the
prefix.

## Port and attempt policy

`Gateway.stream()` yields canonical `StreamEvent`s and `listModels()` completes the port;
the orchestrator persists every cancelled call's result. A stop ends the stream with exactly one
`end`, built in the shared envelope (`adapters/provider-stream.ts`) from what the adapter had
accumulated: the envelope races the SDK against the abort, so a rejecting, returning or hung SDK
all end at once, with the text and usage so far. `attempt-stream.ts` stamps that `end` (and any
real `end` after the stop) with `finishReason: null`, since the adapter's reason says nothing true,
and with `missing_usage` when no provider usage arrived. A timeout aborts the same signal but
stays an error: `attempt-stream.ts` turns an `end` that follows a timeout into the timeout error.
A stop before an attempt starts, including one during retry backoff, made no call and ends the
stream with no events and no response.
Where the routed model is known, `attempt-stream.ts` calls `resolveCall()`
(`domain/resolve-call.ts`) once and hands the adapter a `ResolvedCall`:
`{ cacheTtlSeconds, longCacheWrites, reasoning: "default" | "off" | { effort } }`. Adapters
only map it to wire fields and reject at construction (`assertCacheTtlsOnWire`) a model
whose cache lifetimes they cannot send. The server's registry maps
model IDs to provider adapters and is the single source for model context,
and, per provider offering, pricing and cache descriptor, plus the required tokenizer family. Duplicate model IDs
warn during construction rather than silently replacing an entry. Registry model
facts (limits, prices, modalities, effort ranges) come from
[models.dev](https://models.dev/api.json); a provider's API docs are only for what
models.dev lacks, such as per-TTL cache-write rates and wire parameters. Nothing fetches
models.dev at run time; `pnpm check:models` (network, so outside `pnpm check`) reports a row's
input modalities, context window or output limit that drifted from it.

`attempt-stream.ts` is the only retry layer. Provider SDK retries are disabled.
Retry occurs only before committed text or tool output; reasoning-only
output is retryable. Backoff honors provider retry hints and is abort-aware.
Each attempt has an inactivity stall timer and an absolute ceiling timer on one
derived signal. Every stream event re-arms the stall timer, so a slow model that
keeps streaming is never killed; the ceiling is a backstop, not the normal end.
`MODEL_CALL_STALL_MS` and `MODEL_CALL_TIMEOUT_MS` override the defaults in
`deadline.ts` (`DEFAULT_ATTEMPT_STALL_MS`, `DEFAULT_ATTEMPT_CEILING_MS`); 0
disables either. A timeout is a retryable provider error. Iterator cleanup
cannot hold cancellation hostage.

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
[debugging guide](../../../docs/debugging.md).

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

## Media

One part, `MediaPart` (`{ type: "media", mediaType, filename?, source }`), carries an image or a
PDF in a user message and inside a `ToolResultPart`, whose `content` is an array of text and media
parts. `source` is `{ url }` (https only; a data URL is refused), `{ data }` (base64) or
`{ reference: { provider, id } }` (a provider's own file id, for the provider that issued it; no
mapper sends one yet and one reaching a mapper is an error). `mediaType` is required and never
guessed from a URL. A mapper never downloads a link: a source its wire can't take is an error,
and the caller decides between link and bytes before building the request, because file bytes
should not pass through the server on every model request.

Two levels, in `domain/media.ts`. The model says what it takes: `ModelInfo.inputModalities`
(models.dev's `modalities.input`) and `maxLinkBytes`, the largest file its provider fetches by
link where documented. The wire (`ModelInfo.wire`, stamped from the provider's adapter when the
gateway is built) says whether a link works per kind and where a tool result's media goes.
`placeMedia(model, { mediaType, sizeBytes? })` answers `link`, `bytes` or `none` plus the
placement; it takes the model, not the wire, so the Gemini wire can key placement on the
model's major version (nested `functionResponse` parts need Gemini 3, and `placeMedia` answers
`none` for a file in a tool result, with `inToolResult`, for an older or unrecognised Gemini id).
It also answers `none` for an image type the wire doesn't accept (each wire lists its types), so
the caller can send the preview instead.

| Wire | Link | Tool result media |
|---|---|---|
| `anthropic` (Messages) | image, PDF | inside `tool_result.content` as `image`/`document` blocks; an `is_error` result carries text only (Anthropic rejects media in it) and its media follow the tool results in the same user message |
| `openai` (Responses) | image, PDF | inside `function_call_output.output` as `input_image`/`input_file` |
| `openai-compatible` (Chat Completions) | image only, and only where the provider's `imageLinks` is set (default: bytes) | one user message after the run of `tool` messages, each attachment group named by its tool call; a PDF is bytes only (`file` with `file_data`) |
| `gemini` (native `generateContent`) | image, PDF (`fileData`, up to 15 MB) | Gemini 3 and later: inside `functionResponse.parts` (`fileData` or `inlineData`); older: none |

Image types by wire: Anthropic JPEG, PNG, GIF, WebP; OpenAI and Chat Completions PNG, JPEG, WebP, GIF;
Gemini PNG, JPEG, WebP, HEIC, HEIF (Google lists only PNG, JPEG and WebP for a function response
and nothing rejects the others before the request).
Whether a Chat Completions host fetches image links is that host's fact, so it is
`ProviderConfig.imageLinks` (stamped on `ModelInfo.imageLinks`), not assumed of the wire.

A PDF sent as bytes always has a filename (`document.pdf` by default); one sent by link needs none.
Provider facts and the reasons behind this are in
[files the model sees](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/files-the-model-sees.md).

## Gemini adapter

`adapters/gemini/` calls the native `generateContent` API through `@google/genai`; the SDK reads
every environment option (the key, Vertex mode, project, location, base URL, API version)
only when it is unset, so the adapter passes each, and it retries nothing unless `retryOptions`
is set, which it never is. If the machine sets both of the SDK's own Google key variables it
prints a console warning, and the explicit key still wins. Facts a cold reader would miss:

- A tool result is a `functionResponse` named for its call, found from the earlier `tool_use`;
  results of parallel calls share one user turn (adjacent same-role messages merge).
- Thought signatures live in `providerOptions.gemini.signature` beside `meridian: {provider,
  model}` on the text, reasoning or `tool_use` part they came on, and go back only to that
  provider/model. A replayed first function call of a Gemini 3+ model without one gets
  `skip_thought_signature_validator`, Google's documented bypass, because Gemini 3 refuses the
  step otherwise (history from another model, a compacted turn).
- `Usage` folds thought tokens into `outputTokens` and tool-use prompt tokens into `inputTokens`.
  A file fetched by link is counted in `totalTokenCount` only (`promptTokenCount` is absent), so
  the input is read from the total.
- Google answers a bad key with 400 `API_KEY_INVALID`; the adapter maps it to `auth_error`. The
  SDK's `ApiError` keeps the body as JSON text (twice wrapped for a non-JSON-typed body) and drops
  the headers, so `geminiErrorShape` rebuilds the status, message and `RetryInfo` delay for the
  shared error mapping.
- No cache mark is sent; `automaticFunctionCalling` and `automaticContinuation` are off, so the
  SDK never loops or re-sends a request behind the gateway's retry layer.

## Cache, limits, and persisted selections

A provider lists offerings: `{ model, pricing, promptCache? }`. What an endpoint caches
and charges belongs to the provider serving the model, not to the model (DeepSeek uses
the Anthropic adapter and caches differently). `ModelInfo` stays flat and carries the
offering's `promptCache: { kind, shortTtlSeconds, longTtlSeconds }`. `null` means the provider
documents no lifetime. An offering's `promptCache` is a partial descriptor merged field by
field over the defaults (explicit, `DEFAULT_SUBAGENT_PROMPT_CACHE_TTL` 5m,
`DEFAULT_PRIMARY_PROMPT_CACHE_TTL` 1h), so an offering restates only what differs and an
explicit `null` survives the merge. Lifetimes are the provider's real values in seconds; code
that must beat one computes its buffer from them, as `asks/ask-deadline.ts` does. `validateModelRegistry` and
`ModelInfo` share one resolver. There is no provider-level default.

| Provider | kind | short | long |
| --- | --- | --- | --- |
| Anthropic (Claude) | explicit | 5m | 1h |
| OpenAI (GPT-5.6+) | automatic | 30m | 12h (the shortest option of at least 1 hour, sent as `prompt_cache_options.ttl`; the 30m default is never sent) |
| DeepSeek | automatic | 1h | 1h (lower bound of its documented "a few hours to a few days"; an estimate) |
| Gemini | automatic | null | null |

`GenerateRequest.promptCacheRetention` is required: `long` for primary threads, `short`
for subagents (fixed by thread kind so the cached prefix never varies mid-thread), and
`none` for the rolling summarizer, which resolves to a null lifetime so no mark is sent
(OpenAI still keeps its 30m default; Flow can't turn it off). `longCacheWrites` is true when
the request is long and the two lifetimes differ; when a provider omits the cache-write
split by lifetime, adapters attribute all writes to the lifetime the request asked for.
`validateModelRegistry` rejects a long lifetime shorter than the short one, one null with
the other set, and two lifetimes with `cacheWriteUsdPerMillionTokens` but no
`cacheWriteLongUsdPerMillionTokens`. Each adapter keeps one table of the lifetimes its wire
can express, used for both the creation-time check and the request mapping (OpenAI: 30m and
12h; Anthropic: 5m and 1h, explicit models only; Gemini: none, its implicit cache documents no
lifetime and takes no mark).

Only `explicit` offerings get `cache_control`. The Anthropic adapter marks the last system
block and the last block of the two most recent wire `user` messages (tool results are user
turns there), walking back past a block that cannot carry a mark (thinking, empty text);
DeepSeek gets none and keeps a joined `system` string. The loop places no marks, so every
Anthropic-format request, summarizer calls included, is marked the same way. A null lifetime
means unknown, not infinite: cache prediction reads it as cold (`ttl_unknown`).

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

Each model row's `reasoning: { efforts, canDisable? }` is copied from models.dev
`reasoning_options` (minus `xhigh`, which Flow never requests): `canDisable` is a
`toggle` option or a `none` effort. `resolveReasoning()` turns the request into
`default` (absent or `adaptive`: send no effort, on every adapter), `off` (`disabled`,
only when the model `canDisable`; otherwise the lowest supported effort), or the nearest
supported effort (a tie goes up: DeepSeek has no `medium`, so `medium` becomes `high`).
Wire mapping: the Anthropic adapter (Claude and DeepSeek) sends an effort as
`output_config.effort` and `off` as `thinking: {type: "disabled"}`; the OpenAI Responses
adapter sends `reasoning.effort` (`none` for `off`) with `summary: "auto"`; the
`openai-compatible` adapter (Gemini 4 Argon, Google maps `reasoning_effort` to
`thinking_level`) sends `reasoning_effort`. Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 have
no toggle, so they never resolve to `off`: `thinking: disabled` and `budget_tokens` are a
400 on them, and no registered model gets a thinking budget. Models that declare
`reasoning.thinksByDefault` (DeepSeek; not inferred from `canDisable`) get an empty
thinking block before a replayed `tool_use` unless reasoning is `off`. A provider row
declares `projectToolSchema` (copied onto `ModelInfo`; only Anthropic) to get
`anthropicToolSchema` on its tools; the adapter reads the flag and `model.provider`, never a provider id literal.

Every model declares a tokenizer family with no fallback; runtime compaction
uses it for CJK estimates. No request sets an output limit: adapters that
require an explicit provider field send the registry maximum, and the others
leave the provider default. That maximum is subtracted once from the usable
input window for compaction. Optional work that needs room for one more output
reserves `outputReserveTokens` (capped at 65,536), not the full maximum.

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

## LIVE_TEST_MODEL (dev and staging)

`LIVE_TEST_MODEL=<registry model id>` sends every gateway call to that model, whatever
the request, chat binding or Agent names. `createGatewayFromEnv` (in `lib/gateway/`) validates it (known id,
provider key set), refuses it in production (a staging deploy must set `APP_ENV=staging`),
and wraps the gateway once (`lib/gateway/live-test-model.ts`). The wrapper rewrites the
request's model and lists every registry id, keyed or not, with the override's facts,
because availability checks, compaction, media placement and the tokenizer look models up by
the stored id. Stored bindings, Agent files and the catalog still show the model they
name, and `getDefaultModel()` stays the real default, so seeding never records the
override. Cache prediction is the exception: a chat bound to another model reads cold
(`model_changed`), because its stored responses name the routed model, so its summaries
take the rolling path. Costing prices the provider and model the response reports. The
name has no `FLOW_` prefix because it is not a provider key.
