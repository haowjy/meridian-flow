---
detail: minimal
audience: developer
---

# Provider Routing

## Problem

Backend needs to route LLM requests to the correct provider (Anthropic, OpenRouter, OpenAI, etc.) based on client-specified parameters.

## Solution

Separate provider and model fields with smart defaults: Extract → Infer → Create → Cache

```mermaid
graph TD
    A["Client Request<br/>{provider: 'openrouter', model: 'moonshotai/kimi-k2-thinking'}"] --> B{Provider Specified?}
    B -->|Yes| C[Use Explicit Provider]
    B -->|No| D[Model Mapping]

    D --> E{Prefix Match?}
    E -->|claude-*| F[provider = 'anthropic']
    E -->|gpt-*, o1-*| G[provider = 'openai']
    E -->|gemini-*| H[provider = 'google']
    E -->|lorem-*| I[provider = 'lorem']
    E -->|No match| J[provider = 'openrouter']

    C --> K{Cache Hit?}
    F --> K
    G --> K
    H --> K
    I --> K
    J --> K

    K -->|Yes| L[Return Cached Provider]
    K -->|No| M[Provider Factory]

    M --> N["Create Provider<br/>(with API key)"]
    N --> O[Wrap in Adapter]
    O --> P[Cache for Reuse]
    P --> L

    L --> Q[Execute Request]

    style A fill:#2d5f7d
    style C fill:#2d7d2d
    style J fill:#7d2d5f
    style L fill:#2d7d2d
    style P fill:#7d2d5f
```

## Request Format

**Separate Fields:** Client sends provider and model as distinct parameters

| request_params | Provider Used | Model Sent to Provider | Notes |
|----------------|---------------|------------------------|-------|
| `{model: "claude-haiku-4-5"}` | `anthropic` | `claude-haiku-4-5` | Inferred from `claude-` prefix |
| `{model: "gpt-4o"}` | `openai` | `gpt-4o` | Inferred from `gpt-` prefix |
| `{model: "gemini-2.0-flash"}` | `google` | `gemini-2.0-flash` | Inferred from `gemini-` prefix |
| `{model: "moonshotai/kimi-k2"}` | `openrouter` | `moonshotai/kimi-k2` | No prefix match → defaults to OpenRouter |
| `{provider: "openrouter", model: "anthropic/claude-sonnet-4-5"}` | `openrouter` | `anthropic/claude-sonnet-4-5` | Explicit provider override |

**Implementation:** `backend/internal/domain/models/llm/model_mapping.go:10-41`

## Provider Factory

Creates provider instances with API keys from environment variables.

**Supported Providers:** Anthropic, OpenRouter, OpenAI, Google, Lorem (testing)

**Implementation:** `backend/internal/service/llm/provider_factory.go`

## Registry

Caches provider instances per provider name to avoid recreating clients.

**Thread-safe:** Uses `sync.RWMutex` for concurrent access

**Implementation:** `backend/internal/service/llm/registry.go:27-80`

## Model Mapping

Smart defaults infer provider from model name prefixes when provider not specified.

**Mappings:**
- `claude-*` → anthropic
- `gpt-*`, `o1-*`, `text-*`, `davinci-*` → openai
- `gemini-*` → google
- `lorem-*` → lorem (testing)
- **No match** → openrouter (universal fallback)

**Implementation:** `backend/internal/domain/models/llm/model_mapping.go:10-41`

## References

- **Model mapping:** `backend/internal/domain/models/llm/model_mapping.go`
- **Provider factory:** `backend/internal/service/llm/provider_factory.go`
- **Registry:** `backend/internal/service/llm/registry.go`
- **Request extraction:** `backend/internal/service/llm/streaming/service.go:96-130`

## See Also

- [LLM Integration Guide](llm-integration.md) - Complete backend integration patterns
- [Environment Gating](environment-gating.md) - Tool restrictions
