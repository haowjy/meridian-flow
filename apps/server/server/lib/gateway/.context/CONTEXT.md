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

- `models-snapshot.json`: the [models.dev](https://models.dev/api.json) rows of the offered models (name,
  `release_date`, limits, input modalities, tool calls, `reasoning_options`, `cost` with `cost.tiers`), in models.dev's
  own field names, and the date it was taken. Never edit it by hand; `pnpm models:refresh` rewrites it.
- `families.ts`: which models Flow offers, per provider, as `[models.<family>]`-style `match` and `exclude` globs (as in
  meridian-base's `mars.toml`), plus per-family facts models.dev lacks: tokenizer, `maxLinkBytes`, `thinksByDefault`.
  A family id is its alias in `mars.toml` (`opus`, `sonnet`, `fable`, `sol`, `terra`, `luna`, `deepseek`, `argon`),
  kept equal by hand: nothing in CI reads `mars.toml`. Flow has no family Mars lacks, and Mars has aliases Flow does not offer (haiku, astra, glm, kimi, grok and others).
  Also the default model; the build fails when the snapshot lacks it. A new version in a listed family appears at the
  next refresh; an `exclude` entry is a dated, deprecated or older-generation id Flow does not offer. `newestInFamily`
  applies Mars's alias rule (`resolveAlias` from `@meridian-flow/mars-schema`) to a family.
- `provider-rows.ts`: per provider, the wire, base URL, `FLOW_` key name, tool-schema projection, the full
  `promptCache` descriptor, the long-TTL cache-write multiplier (Anthropic 2x input, OpenAI 2.5x) and `priceOverrides`,
  the one way Flow charges a price other than models.dev's (a rate per model id): DeepSeek's peak rates, and Gemini 4
  Argon's standard rates while models.dev lists Google's introductory ones. Each carries a `source` URL and a `checked`
  date; a refresh report flags one older than 90 days, prints models.dev's number beside the billed one, and says
  "models.dev now agrees: delete the override" once they match. An override replaces every rate models.dev lists for
  its model, and it is absolute (no multiplier, which would double-charge once models.dev catches up). Because a
  family can admit a model its override was not written for, loading the registry fails when a family has an override for any
  model and another model it admits has none, or when models.dev lists a cache rate the override leaves unset; the
  refresh report shows each as "Price overrides that do not cover the snapshot", naming the family and the rates. The report mode (`--dry-run`) lists the gaps and builds the new
  registry anyway, so the daily issue still shows every other change; write mode refuses. The check covers families that
  hold an override, not a provider's new family.

`registry.ts` joins them (`buildModelRegistry`) and keeps the exported registry types. Billing charges the snapshot's
prices, never live data; a charge's `pricingSnapshot.source` reads `models.dev snapshot <date>`, plus the provider
row's source for an overridden price or a derived rate. A single `cost.tiers` step becomes `inputTierTokens` and `aboveTierMultipliers`;
the build throws when the step is not one threshold with one multiplier for every input-side rate. A snapshot row the
allowlist no longer admits (a new `exclude`) gets no offering and stays in the file until the next refresh.

**Names.** `RegisteredModel.displayName` is the picker name: the family alias on the newest model of a family (by
`newestInFamily`), "alias version" on an older one (`fable 5.1`, the version being the first number in models.dev's name,
so two older models can share it). Of those, the shorter id keeps "alias version" and each other is marked with what its
id adds (`fable 5.1 20261201`): a name once shown never changes when a sibling arrives. Picker names are unique: the
build fails, naming the models, on two offerings with the same name.
An Agent file's `model` may be a picker name: `resolveModelName` turns a family alias into its newest available
model and an "alias version" into that model; an id stays as written. `modelFor(gateway, named?)` is the one port that
names a model: the default for no name, else `resolveModelName`. It runs when a chat starts
(`resolveAgentConfiguration`), for the catalog's availability check, and on a spawn's `overrides.model`
(`resolveChildInvocation`), and the binding stores the id. A running chat
keeps it: each turn reads the binding in `resolveAgentThreadTurnContext`, and a model still offered is never moved. A
binding whose model the host no longer offers moves, at that read and for a child thread too, to the Agent's current
model (`followRemovedModel`, which stores the new binding). `refreshBinding` at a compaction keeps the bound model while
the Agent's `model` line is unchanged and the model is still offered; otherwise the chat follows the Agent's current model.

Provider keys are read only from `FLOW_`-prefixed variables (`FLOW_ANTHROPIC_API_KEY`,
`FLOW_DEEPSEEK_API_KEY`, …), never the vendors' unprefixed names. The owner's machine sets the unprefixed
keys for local subscriptions, and Flow must not bill those. `check:negative-space` enforces the prefix.
Each provider's key goes in `ProviderConfig.auth` as `{ apiKey }`; Flow sets no per-call `GenerateRequest.auth`.

Model facts come from models.dev through the snapshot; a provider's API docs are only for what models.dev lacks, which
the provider rows hold. Nothing fetches models.dev at run time.

**Refreshing.** `pnpm models:refresh` (`apps/server/scripts/models-refresh.ts`, network, outside `pnpm check`) fetches
models.dev, rewrites the snapshot, and prints the report: new and removed models, every price change as old → new,
cache rates models.dev dropped (billing would fall back to the input rate), limit, modality, reasoning and cache
changes, the prices Flow overrides beside models.dev's, the derived long-TTL cache-write prices, and a "Not from
models.dev" section listing each provider-row fact with its source and checked date (marked **re-check** after 90
days). It refuses to write when the new snapshot would not build or a family-matched row can't be served. A person
runs it on a branch, reads the report, and opens a PR; a charge changes only when that PR merges. `--dry-run` is
report mode: it leaves the snapshot alone, and a row Flow can't serve (or a snapshot that would not build) becomes
a report section ("matched family X, can't serve it: add an exclude") instead of an error. The daily
`.github/workflows/models-refresh.yml` runs it with `--dry-run` and keeps one open issue, "models.dev changes",
whose body is the report; it closes the issue when the snapshot matches models.dev, and a failed run puts its error
into the same issue. It uses the built-in `GITHUB_TOKEN` and commits and opens nothing.

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

A provider lists offerings `{ model, pricing, promptCache }`: what an endpoint caches and charges belongs to the
provider serving the model (DeepSeek uses the Anthropic adapter and caches differently). The provider row holds the
full `promptCache` descriptor; there are no defaults to merge over. Lifetimes are the provider's real values; code that must
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
1.5x output above it. The snapshot has no effective dates: Gemini 4 Argon bills Google's standard rates through a price override, whose
report line says to delete it once models.dev lists them (Google's introductory rates end 2026-11-30).

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
