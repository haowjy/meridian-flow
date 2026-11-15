# Gateway wiring

The model gateway itself is the npm package `@meridian-flow/gateway`, built in the
[`meridian-runtime`](https://github.com/haowjy/meridian-runtime) repository: its
[package CONTEXT](https://github.com/haowjy/meridian-runtime/blob/main/packages/gateway/.context/CONTEXT.md)
covers the port, adapters, retry, errors, credentials, media and the mock server. This directory is what Flow
chooses and reads from its environment: the model registry and prices, the `FLOW_` keys, the
observability decorator, the dev overrides. To change the package and try it here before it is
published, see [Shared runtime in the root AGENTS.md](../../../../../AGENTS.md).

## Registry and keys

`registry.ts` holds the model registry with its prices, and `create-from-env.ts` builds the gateway from
it. The registry mixes provider facts with what Flow offers and charges, so it stays whole here until a
second consumer needs the facts split out. A bad row fails at construction, not in the deployment that
holds that provider's key.

Provider keys are read only from `FLOW_`-prefixed variables (`FLOW_ANTHROPIC_API_KEY`,
`FLOW_DEEPSEEK_API_KEY`, …), never the vendors' unprefixed names. The owner's machine sets the unprefixed
keys for local subscriptions, and Flow must not bill those. `check:negative-space` enforces the prefix.
Each provider's key goes in `ProviderConfig.auth` as `{ apiKey }`; Flow sets no per-call `GenerateRequest.auth`.

The registry maps model IDs to provider adapters and is the single source for model context, and, per
provider offering, pricing and cache descriptor, plus the required tokenizer family. Duplicate model IDs
warn during construction rather than silently replacing an entry. Registry model facts (limits, prices,
modalities, effort ranges) come from [models.dev](https://models.dev/api.json); a provider's API docs are
only for what models.dev lacks, such as per-TTL cache-write rates and wire parameters. Nothing fetches
models.dev at run time; `pnpm check:models` (network, so outside `pnpm check`) reports a row's input
modalities, context window or output limit that drifted from it.

The model-request debug capture (`domains/runtime/model-request-debug/build-record.ts`) copies named
request fields, so `GenerateRequest.auth` and any field the package adds later stay out of it.

## Retry and deadlines

The package retries and times out each attempt (stall timer, absolute ceiling). `MODEL_CALL_STALL_MS` and
`MODEL_CALL_TIMEOUT_MS` override its defaults (`DEFAULT_ATTEMPT_STALL_MS`, `DEFAULT_ATTEMPT_CEILING_MS`)
through `defaultGatewayOptions` in `providers.ts`; 0 disables either.

## Instrumentation

`instrumented-gateway.ts` wraps the production-composed gateway once. It emits lifecycle records keyed by
`gatewayCallId`; request capture is a separate bounded debug port and never enters EventSink, thread
snapshots, journal rows, or JSONL.

## Cache, limits and persisted selections

A provider lists offerings: `{ model, pricing, promptCache? }`. What an endpoint caches and charges
belongs to the provider serving the model, not to the model (DeepSeek uses the Anthropic adapter and
caches differently). `ModelInfo` stays flat and carries the offering's
`promptCache: { kind, shortTtlSeconds, longTtlSeconds }`. `null` means the provider documents no lifetime.
An offering's `promptCache` is a partial descriptor merged field by field over the defaults (explicit,
`DEFAULT_SUBAGENT_PROMPT_CACHE_TTL` 5m, `DEFAULT_PRIMARY_PROMPT_CACHE_TTL` 1h), so an offering restates only
what differs and an explicit `null` survives the merge. Lifetimes are the provider's real values in seconds;
code that must beat one computes its buffer from them, as `asks/ask-deadline.ts` does.
`validateModelRegistry` and `ModelInfo` share one resolver. There is no provider-level default.

| Provider | kind | short | long |
| --- | --- | --- | --- |
| Anthropic (Claude) | explicit | 5m | 1h |
| OpenAI (GPT-5.6+) | automatic | 30m | 12h (the shortest option of at least 1 hour, sent as `prompt_cache_options.ttl`; the 30m default is never sent) |
| DeepSeek | automatic | 1h | 1h (lower bound of its documented "a few hours to a few days"; an estimate) |
| Gemini | automatic | null | null |

`GenerateRequest.promptCacheRetention` is required: `long` for primary threads, `short` for subagents
(fixed by thread kind so the cached prefix never varies mid-thread), and `none` for the rolling summarizer,
which resolves to a null lifetime so no mark is sent (OpenAI still keeps its 30m default; Flow can't turn it
off). `validateModelRegistry` rejects a long lifetime shorter than the short one, one null with the other
set, and two lifetimes with `cacheWriteUsdPerMillionTokens` but no `cacheWriteLongUsdPerMillionTokens`.
Each adapter keeps one table of the lifetimes its wire can express, used for both the creation-time check
and the request mapping (`assertModelsOnWire` runs it over every row).

Claude and GPT-5.6+ bill cache writes by the TTL written: pricing bills `Usage.cacheWriteLongTokens` at
`cacheWriteLongUsdPerMillionTokens` (Claude 2x input, OpenAI 2.5x) and the rest at
`cacheWriteUsdPerMillionTokens` (the short rate: Claude 1.25x, OpenAI 1.25x). Providers that do not split
writes use the single rate. `inputTierTokens`, when present, must be positive and below the context window;
the runtime uses it for compaction planning, and with `aboveTierMultipliers` costing reprices a request whose
input exceeds it (OpenAI GPT-5.6+: whole request at 2x input and cache, 1.5x output above 272K). Registry
rates are pinned at standard prices; Gemini 4 Argon's intro discount ends 2026-11-30 and the registry has no
effective dates.

Each model row's `reasoning: { efforts, canDisable? }` is copied from models.dev `reasoning_options` (minus
`xhigh`, which Flow never requests): `canDisable` is a `toggle` option or a `none` effort. The package's
`resolveReasoning()` turns the request into `default`, `off` (only when the model `canDisable`; otherwise the
lowest supported effort), or the nearest supported effort (a tie goes up: DeepSeek has no `medium`, so
`medium` becomes `high`). Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 have no toggle, so they never resolve to
`off`: `thinking: disabled` and `budget_tokens` are a 400 on them, and no registered model gets a thinking
budget. Models that declare `reasoning.thinksByDefault` (DeepSeek; not inferred from `canDisable`) get an
empty thinking block before a replayed `tool_use` unless reasoning is `off`. A provider row declares
`projectToolSchema` (only Anthropic) to get `anthropicToolSchema` on its tools.

Every model declares a tokenizer family with no fallback; runtime compaction uses it for CJK estimates. No
request sets an output limit: adapters that require an explicit provider field send the registry maximum, and
the others leave the provider default. That maximum is subtracted once from the usable input window for
compaction. Optional work that needs room for one more output reserves `outputReserveTokens` (capped at
65,536), not the full maximum.

Thread Agent bindings retain their resolved model selection. A retired or unregistered stored model fails
route resolution before provider dispatch; no local-data remapping or compatibility alias is allowed.
Direct Anthropic rejects a root `oneOf` or `anyOf`, so its adapter advertises one object envelope carrying
each command's purpose, required and allowed fields, and command-tagged descriptions generated from the Zod
branches. DeepSeek receives the canonical unions unchanged, and a root `allOf` is refused at tool
registration.

## Dev mock and `MOCK_MODEL_RESPONSE`

With no provider key, or `MODEL_PROVIDER=mock`, `createGatewayFromEnv` starts the package's in-process mock
server. `MOCK_MODEL_RESPONSE` is a JSON default response for it (tool-free; the same content and pacing
fields as a script step, never `times`). Controls and fixtures:
[debugging guide](../../../../../docs/debugging.md#mock-provider-responses). Recipe:
[rich mock provider](qa/mock-provider.md).

## LIVE_TEST_MODEL (dev and staging)

`LIVE_TEST_MODEL=<registry model id>` sends every gateway call to that model, whatever the request, chat
binding or Agent names. `createGatewayFromEnv` validates it (known id, provider key set), refuses it in
production (a staging deploy must set `APP_ENV=staging`), and wraps the gateway once
(`live-test-model.ts`). The wrapper rewrites the request's model and lists every registry id, keyed or not,
with the override's facts, because availability checks, compaction, media placement and the tokenizer look
models up by the stored id. Stored bindings, Agent files and the catalog still show the model they name, and
`getDefaultModel()` stays the real default, so seeding never records the override. Cache prediction is the
exception: a chat bound to another model reads cold (`model_changed`), because its stored responses name the
routed model, so its summaries take the rolling path. Costing prices the provider and model the response
reports. The name has no `FLOW_` prefix because it is not a provider key.
