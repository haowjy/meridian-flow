# Gateway wiring

The model gateway itself is the `@meridian-flow/runtime/gateway` entry of the npm package `@meridian-flow/runtime`, built in the
[`meridian-runtime`](https://github.com/haowjy/meridian-runtime) repository: its
[package CONTEXT](https://github.com/haowjy/meridian-runtime/blob/main/src/gateway/.context/CONTEXT.md)
covers the port, adapters, retry, errors, credentials, media and the mock server. This directory is what Flow
chooses and reads from its environment: the model registry and prices, the `FLOW_` keys, the
observability decorator, the dev overrides. To change the package and try it here before it is
published, see [Shared runtime in the root AGENTS.md](../../../../../AGENTS.md).

## Registry and keys

The registry is built from three files here, and `create-from-env.ts` builds the gateway from it. A bad row fails
when the registry is built, not in the deployment that holds that provider's key.

- `models-snapshot.json`: the [models.dev](https://models.dev/api.json) rows of the offered models (name, limits,
  input modalities, tool calls, `reasoning_options`, `cost` with `cost.tiers`), in models.dev's own field names, and
  the date it was taken. Never edit it by hand; `pnpm models:refresh` rewrites it.
- `families.ts`: which models Flow offers, per provider, as `[models.<family>]`-style `match` and `exclude` globs (as in
  meridian-base's `mars.toml`), plus per-family facts models.dev lacks: tokenizer, `maxLinkBytes`, `thinksByDefault`.
  Also the default model; the build fails when the snapshot lacks it. A new version in a listed family appears at the
  next refresh; an `exclude` entry is a version Flow chose not to offer.
- `provider-rows.ts`: per provider, the wire, base URL, `FLOW_` key name, tool-schema projection, cache lifetimes,
  the long-TTL cache-write multiplier (Anthropic 2x input, OpenAI 2.5x) and DeepSeek's peak-rate multiplier. Each carries
  a `source` URL and a `checked` date; a refresh report flags one older than 90 days.

`registry.ts` joins them (`buildModelRegistry`) and keeps the exported registry types. Billing charges the snapshot's
prices, never live data; a charge's `pricingSnapshot.source` reads `models.dev snapshot <date>`, plus the provider
row's source for a derived rate. A single `cost.tiers` step becomes `inputTierTokens` and `aboveTierMultipliers`;
the build throws when the step is not one threshold with one multiplier for every input-side rate.

Provider keys are read only from `FLOW_`-prefixed variables (`FLOW_ANTHROPIC_API_KEY`,
`FLOW_DEEPSEEK_API_KEY`, …), never the vendors' unprefixed names. The owner's machine sets the unprefixed
keys for local subscriptions, and Flow must not bill those. `check:negative-space` enforces the prefix.
Each provider's key goes in `ProviderConfig.auth` as `{ apiKey }`; Flow sets no per-call `GenerateRequest.auth`.

Model facts come from models.dev through the snapshot; a provider's API docs are only for what models.dev lacks, which
the provider rows hold. Nothing fetches models.dev at run time.

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

## Cache, prices and reasoning rows

How the package models cache lifetimes, retention, cache-write billing, tiers, reasoning resolution and tool-schema
envelopes is in its [CONTEXT](https://github.com/haowjy/meridian-runtime/blob/main/src/gateway/.context/CONTEXT.md).
This section is the values Flow puts in the provider rows and families.

A provider lists offerings `{ model, pricing, promptCache? }`: what an endpoint caches and charges belongs to the
provider serving the model (DeepSeek uses the Anthropic adapter and caches differently). `registry.ts` merges an
offering's partial `promptCache` field by field over its defaults (explicit, `DEFAULT_SUBAGENT_PROMPT_CACHE_TTL` 5m,
`DEFAULT_PRIMARY_PROMPT_CACHE_TTL` 1h), so an explicit `null` survives, and `ModelInfo` and `validateModelRegistry`
share that one resolver. There is no provider-level default. Lifetimes are the provider's real values; code that must
beat one computes its buffer from them, as `asks/ask-deadline.ts` does.

`validateModelRegistry` runs when the registry loads and throws on: lifetimes not both set or both null; a long
lifetime shorter than the short one; two lifetimes with `cacheWriteUsdPerMillionTokens` but no
`cacheWriteLongUsdPerMillionTokens`; and an `inputTierTokens` that is not positive and below the context window.
`create-from-env.ts` also runs the package's `assertModelsOnWire` over every row.

| Provider | kind | short | long |
| --- | --- | --- | --- |
| Anthropic (Claude) | explicit | 5m | 1h |
| OpenAI (GPT-5.6+) | automatic | 30m | 12h (the shortest option of at least 1 hour, sent as `prompt_cache_options.ttl`; the 30m default is never sent) |
| DeepSeek | automatic | 1h | 1h (lower bound of its documented "a few hours to a few days"; an estimate) |
| Gemini | automatic | null | null |

Flow sets `promptCacheRetention` by thread kind so the cached prefix never varies mid-thread: `long` for primary
threads, `short` for subagents, `none` for the rolling summarizer (OpenAI still keeps its 30m default; Flow can't
turn it off).

Claude and GPT-5.6+ rows carry both write rates (Claude 1.25x input short, 2x long; OpenAI 1.25x short, 2.5x long).
OpenAI GPT-5.6+ rows set `inputTierTokens` to 272K with `aboveTierMultipliers`: whole request at 2x input and cache,
1.5x output above it. The snapshot has no effective dates: Gemini 4 Argon's intro rates end 2026-11-30, and the refresh after that moves the
snapshot to the standard ones.

Each model row's `reasoning: { efforts, canDisable? }` comes from models.dev `reasoning_options` (only the
efforts in the package's `REASONING_EFFORTS`, so `xhigh` drops): `canDisable` is a `toggle` option or a `none` effort. Claude Opus 5.5, Sonnet 5.5 and
Fable 5.1 have no toggle, so `thinking: disabled` and `budget_tokens` are a 400 on them, and no registered model gets
a thinking budget. DeepSeek rows declare `reasoning.thinksByDefault` (not inferred from `canDisable`) and the
Anthropic row declares `projectToolSchema`.

Every model declares a tokenizer family with no fallback. No request sets an output limit; the registry maximum is
subtracted once from the usable input window for compaction, and optional work reserves `outputReserveTokens` (capped
at 65,536) instead.

Thread Agent bindings retain their resolved model selection. A retired or unregistered stored model fails route
resolution before provider dispatch; no local-data remapping or compatibility alias is allowed.

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
