# Gateway model registry and errors

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

## Context-window errors

Every adapter normalizes a provider's context-window rejection to the one provider-neutral code `context_overflow`, non-retryable. Anthropic's `model_context_window_exceeded` stop reason is missing from the SDK union, so `anthropic/stream-collect.ts` matches the wire string and emits the error with the metered partial result; OpenAI Responses maps `context_length_exceeded`; the HTTP error mappers match context-length messages, not any message containing "token". The error event's `result` carries metered usage so the loop can bill it. The runtime turns `context_overflow` into one cold compaction and one retry per reply. With provider fallback enabled, the router yields a non-retryable error at once and only a retryable error moves to the next provider. A router that drops a non-retryable error ends the stream with no terminal event, and the loop never sees the overflow.

## DeepSeek cache evidence

DeepSeek evidence for the automatic classification: its [context-caching guide](https://api-docs.deepseek.com/guides/kv_cache/) says caching is enabled by default and reports cache-hit counters; its [Anthropic compatibility guide](https://api-docs.deepseek.com/guides/anthropic_api/) documents the configured `/anthropic` endpoint and says `cache_control` is ignored. In the dev database, `model_responses` had 31 `deepseek-v4-flash` rows, 29 with positive `cache_read_tokens` (188,416 total). The Anthropic adapter's `mapUsage` reads `cache_read_input_tokens`; those persisted counters confirm the deployed compatibility path exposes cache reads through our existing mapping.
