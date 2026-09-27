# Gateway model cache descriptors

`config/registry.ts` is the source of truth for each model's prompt cache behavior. Every `RegisteredModel` has `promptCache: { kind, ttlMs }`; `buildFromRegistry` carries it into `ModelInfo` so assembly and adapters use one declaration.

| Models | Descriptor | Reason |
|---|---|---|
| Anthropic and OpenRouter Claude | `explicit`, 1 hour | Flow places canonical breakpoints. Anthropic and OpenRouter translate them to their explicit `cache_control` wire format. |
| OpenAI Responses | `automatic`, 5 minutes | OpenAI caches supported model prefixes automatically. Five minutes is a conservative estimate for the currently registered models' in-memory cache. |
| DeepSeek V4 Flash | `automatic`, 1 hour | DeepSeek documents automatic context caching; the one-hour TTL is a conservative estimate against the documented usual retention of hours to days. DeepSeek's Anthropic-compatible endpoint ignores explicit `cache_control`, so it must not receive Flow's explicit marks. |
| Non-Anthropic OpenRouter | `none`, unknown TTL | No cache behavior is declared for these routed models. |

The Anthropic and OpenAI-compatible request mappers translate descriptor TTLs of five minutes or one hour. Only explicit models are marked during loop assembly; automatic models receive no marks, and none models are always predicted cold. A nullable TTL is unknown, not infinite: the read model predicts cold when it cannot establish a freshness window.

DeepSeek evidence for the automatic classification: its [context-caching guide](https://api-docs.deepseek.com/guides/kv_cache/) says caching is enabled by default and reports cache-hit counters; its [Anthropic compatibility guide](https://api-docs.deepseek.com/guides/anthropic_api/) documents the configured `/anthropic` endpoint and says `cache_control` is ignored. In the dev database, `model_responses` had 31 `deepseek-v4-flash` rows, 29 with positive `cache_read_tokens` (188,416 total). The Anthropic adapter's `mapUsage` reads `cache_read_input_tokens`; those persisted counters confirm the deployed compatibility path exposes cache reads through our existing mapping.
