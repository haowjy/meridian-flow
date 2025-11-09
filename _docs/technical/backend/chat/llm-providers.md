---
detail: standard
audience: developer
---

# LLM Provider Architecture

Multi-provider abstraction layer for supporting multiple LLM APIs (Anthropic, OpenAI, Google, etc.)

## Overview

The provider architecture allows Meridian to support multiple LLM services through a unified interface, enabling:
- Easy switching between providers
- Provider-specific feature support (thinking modes, streaming, tool calling)
- Centralized provider management
- Consistent error handling across providers

## Provider Interface

All providers implement the `LLMProvider` interface defined in `internal/domain/services/llm/provider.go`:

```go
type LLMProvider interface {
    // GenerateResponse generates a complete response from the LLM
    GenerateResponse(ctx context.Context, req *GenerateRequest) (*GenerateResponse, error)

    // Name returns the provider's unique identifier
    Name() string

    // SupportsModel returns whether the provider supports a given model
    SupportsModel(model string) bool
}
```

### Request/Response Models

**GenerateRequest:**
```go
type GenerateRequest struct {
    Model           string
    SystemPrompt    *string
    Messages        []Message
    Temperature     *float64
    TopP            *float64
    TopK            *int
    MaxTokens       *int
    StopSequences   []string
    ThinkingEnabled *bool
    ThinkingBudget  *string  // "low", "medium", "high"
}
```

**GenerateResponse:**
```go
type GenerateResponse struct {
    Content          []ContentBlock
    Model            string
    StopReason       string
    InputTokens      int
    OutputTokens     int
    ResponseMetadata map[string]interface{}  // Provider-specific data
}
```

## Provider Registry

Central registry for provider management located in `internal/service/llm/registry.go`:

```go
// Create registry
registry := llm.NewProviderRegistry()

// Register providers
registry.RegisterProvider(anthropicProvider)
registry.RegisterProvider(openaiProvider)

// Get provider by name
provider := registry.GetProvider("anthropic")

// Get all registered providers
providers := registry.ListProviders()
```

**Key Features:**
- Thread-safe registration
- Provider lookup by name
- List all available providers
- Validation during registration

## Implemented Providers

### Anthropic Claude

**Status:** ✅ Fully implemented

**Location:** `internal/service/llm/providers/anthropic/`

**Supported Models:**
- `claude-haiku-4-5-20251001` - Fast, cost-effective
- `claude-sonnet-4-5-20250514` - Balanced performance
- `claude-opus-4-5-20250514` - Most capable

**Features:**
- ✅ Extended thinking support (low/medium/high budgets)
  - Low: 2000 tokens
  - Medium: 5000 tokens
  - High: 12000 tokens
- ✅ Temperature control (0.0 - 1.0)
- ✅ Top-k and top-p sampling
- ✅ Stop sequences
- ✅ Token tracking (input/output)
- ✅ Request/response metadata capture
- ❌ Streaming (planned for Task 5)
- ❌ Tool calling (planned)

**Files:**
- `adapter.go` - Converts between domain models and Anthropic API format
- `client.go` - HTTP client and API integration
- `config.go` - Provider configuration

**Configuration:**
```env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

**Example Usage:**
```go
provider := anthropic.NewProvider(apiKey, defaultModel, logger)
response, err := provider.GenerateResponse(ctx, request)
```

### OpenAI (Planned)

**Status:** ❌ Not implemented

**Planned Models:**
- `gpt-4o`
- `gpt-4o-mini`
- `o1-preview`
- `o1-mini`

**Planned Location:** `internal/service/llm/providers/openai/`

### Google Gemini (Planned)

**Status:** ❌ Not implemented

**Planned Models:**
- `gemini-2.0-flash-exp`
- `gemini-exp-1206`

**Planned Location:** `internal/service/llm/providers/google/`

## Adding a New Provider

To add support for a new LLM provider:

### 1. Create Provider Directory

```bash
mkdir -p internal/service/llm/providers/{provider_name}
```

### 2. Implement Provider Interface

Create `client.go`:

```go
package providername

import (
    "context"
    domainllm "meridian/internal/domain/services/llm"
)

type Provider struct {
    apiKey string
    model  string
    logger *slog.Logger
}

func NewProvider(apiKey, model string, logger *slog.Logger) *Provider {
    return &Provider{
        apiKey: apiKey,
        model:  model,
        logger: logger,
    }
}

func (p *Provider) GenerateResponse(ctx context.Context, req *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
    // Implementation here
}

func (p *Provider) Name() string {
    return "providername"
}

func (p *Provider) SupportsModel(model string) bool {
    // Check if model is supported
}
```

### 3. Create Adapter

Create `adapter.go` to convert between your provider's API format and domain models:

```go
package providername

func toProviderRequest(req *domainllm.GenerateRequest) *ProviderAPIRequest {
    // Convert domain request to provider's format
}

func fromProviderResponse(resp *ProviderAPIResponse) *domainllm.GenerateResponse {
    // Convert provider's response to domain format
}
```

### 4. Add Configuration

Add to `internal/config/config.go`:

```go
// Provider config
ProviderAPIKey  string `env:"PROVIDER_API_KEY,required"`
ProviderModel   string `env:"PROVIDER_MODEL" envDefault:"default-model"`
```

### 5. Register Provider

In `cmd/server/main.go`:

```go
import providername "meridian/internal/service/llm/providers/providername"

// Create provider
providerClient := providername.NewProvider(
    cfg.ProviderAPIKey,
    cfg.ProviderModel,
    logger,
)

// Register with registry
llmRegistry.RegisterProvider(providerClient)
```

### 6. Test

Add tests in `providers/{provider_name}/client_test.go`:

```go
func TestProvider_GenerateResponse(t *testing.T) {
    // Test implementation
}
```

## Provider Selection

The chat service uses the provider registry to look up providers by model name. Provider selection logic in `internal/service/llm/response_generator.go`:

```go
func (g *ResponseGenerator) GenerateResponse(ctx context.Context, turnID string, model string, params map[string]interface{}) (*Response, error) {
    // Get provider from registry based on model
    provider := g.registry.GetProviderForModel(model)

    // Generate response
    response, err := provider.GenerateResponse(ctx, request)
}
```

## Error Handling

All providers should follow consistent error handling patterns:

**Domain Errors:**
- `ErrProviderNotFound` - Provider not registered
- `ErrModelNotSupported` - Model not supported by provider
- `ErrAPIError` - Provider API returned error
- `ErrInvalidRequest` - Invalid request parameters

**Example:**
```go
if !p.SupportsModel(req.Model) {
    return nil, fmt.Errorf("%w: model %s not supported by %s",
        domain.ErrModelNotSupported, req.Model, p.Name())
}
```

## Metadata Handling

Each provider can include provider-specific metadata in responses via `ResponseMetadata`:

```go
response := &domainllm.GenerateResponse{
    Content: content,
    ResponseMetadata: map[string]interface{}{
        "provider":       "anthropic",
        "api_version":    "2023-06-01",
        "model_version":  "claude-haiku-4-5-20251001",
        "cache_stats":    cacheInfo,
    },
}
```

This metadata is stored in the `turns` table (`response_metadata` JSONB field) for debugging and analytics.

## Future Enhancements

**Task 5: Streaming Infrastructure**
- Add `StreamResponse()` method to interface
- Implement channel-based streaming
- Background goroutine execution
- Event accumulation and storage

**Multi-Provider Features:**
- Automatic fallback to alternative providers
- Load balancing across providers
- Cost optimization (route to cheapest provider)
- Provider-specific feature detection

## References

- **Implementation:** `internal/service/llm/providers/`
- **Interface:** `internal/domain/services/llm/provider.go`
- **Registry:** `internal/service/llm/registry.go`
- **Response Generator:** `internal/service/llm/response_generator.go`
- **Chat Service:** `internal/service/llm/chat.go`
