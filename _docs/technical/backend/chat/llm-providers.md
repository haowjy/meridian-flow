---
detail: standard
audience: developer
---

# LLM Provider Architecture

> **NOTE:** This document describes the **V5 standalone library architecture** using `meridian-llm-go`. For the legacy internal provider pattern, see commit history.

## Overview

The backend integrates with **`meridian-llm-go`**, a standalone Go library that provides a unified abstraction layer for multiple LLM providers (Anthropic, OpenAI, Gemini, OpenRouter).

**Benefits:**
- **Single library** handles all provider integrations
- **Backend focuses on business logic** (provider selection, tool execution, retry strategies)
- **Easy switching** between providers via simple string parameter
- **Consistent error handling** through normalized error types
- **Shared capability validation** across all consumers

**Architecture:**
```
Backend (meridian/backend)
    ↓ imports
meridian-llm-go (standalone library)
    ├── Core layer (Block, Message, abstractions)
    ├── Adapter layer (Anthropic, OpenAI, Gemini, OpenRouter)
    └── Capabilities (YAML configs for validation)
```

**See:** [`_docs/technical/llm/`](../../llm/) for complete library documentation

## Library API

The backend uses the `meridian-llm-go` library client to interact with all providers:

```go
// File: meridian-llm-go/client.go

type LLMClient struct {
    // Internal: providers, capabilities, validator
}

// Initialize library with capability configs
func NewLLMClient(configDir string) (*LLMClient, error)

// Generate complete response
func (c *LLMClient) GenerateResponse(ctx context.Context, provider string, req *GenerateRequest) (*Response, error)

// Generate streaming response
func (c *LLMClient) GenerateStream(ctx context.Context, provider string, req *GenerateRequest) (*StreamHandle, error)

// Helper: Detect tool execution side
func (c *LLMClient) GetToolExecutionSide(block *Block) ToolExecutionSide
```

**Supported Providers** (pass as string parameter):
- `"anthropic"` - Claude models
- `"openai"` - GPT models
- `"gemini"` - Google Gemini models
- `"openrouter"` - Proxy to multiple providers

### Request/Response Models

**GenerateRequest** (Block-centric):
```go
type GenerateRequest struct {
    Model    string
    Messages []Message      // Messages contain Blocks
    Params   RequestParams  // Thinking, tools, sampling
}

type Message struct {
    Role   string   // "user", "assistant"
    Blocks []*Block // Content blocks
}

type Block struct {
    Sequence  int
    BlockType string                 // "text", "image", "tool_use", "tool_result", "thinking"
    Content   map[string]interface{} // Block-specific content
}

type RequestParams struct {
    Thinking         *ThinkingConfig
    Tools            []Tool       // Unified: both built-in and custom tools
    ToolChoice       *ToolChoice  // Controls whether/which tools to use
    Temperature      *float64
    TopP             *float64
    TopK             *int
    MaxTokens        *int
    StopSequences    []string
}
```

**Response:**
```go
type Response struct {
    Blocks       []*Block  // Response content blocks
    Model        string
    StopReason   string
    InputTokens  int
    OutputTokens int
    Metadata     map[string]interface{}
}
```

## Backend Integration

### Initialization

```go
// File: backend/internal/service/llm/service.go

type LLMService struct {
    client   *llm.LLMClient
    provider string  // Default provider ("anthropic", "openai", etc.)
    logger   *slog.Logger
}

func NewLLMService(cfg *config.Config) (*LLMService, error) {
    // Capability configs loaded from backend/config/capabilities/
    configDir := filepath.Join(cfg.RootDir, "config")

    // Initialize library client
    client, err := llm.NewLLMClient(configDir)
    if err != nil {
        return nil, fmt.Errorf("init LLM client: %w", err)
    }

    return &LLMService{
        client:   client,
        provider: cfg.LLMProvider,  // From environment
        logger:   cfg.Logger,
    }, nil
}
```

**Backend responsibilities:**
1. Initialize library client with capability configs
2. Select provider based on business logic (user tier, rate limits, fallback rules)
3. Convert domain models ↔ library blocks
4. Implement custom tool execution
5. Handle tool execution loop
6. Apply retry strategies
7. Format errors for users

**Library responsibilities:**
1. Provider abstraction and switching
2. Format translation (Block ↔ provider API format)
3. Streaming infrastructure
4. Error normalization
5. Capability validation

## Usage Examples

### Basic Response Generation

```go
// File: backend/internal/service/llm/chat_service.go

func (s *LLMService) GenerateTurn(ctx context.Context, chatID, userMessage string) (*Turn, error) {
    // Build library request
    req := &llm.GenerateRequest{
        Model: "claude-sonnet-4-5",
        Messages: []llm.Message{
            {
                Role: "user",
                Blocks: []*llm.Block{
                    {
                        BlockType: "text",
                        Content: map[string]interface{}{
                            "text": userMessage,
                        },
                    },
                },
            },
        },
    }

    // Call library with provider selection
    resp, err := s.client.GenerateResponse(ctx, s.provider, req)
    if err != nil {
        return nil, s.handleError(err)
    }

    // Convert library blocks to domain Turn
    return s.convertToTurn(chatID, resp), nil
}
```

### Streaming Response

```go
func (s *LLMService) GenerateTurnStream(ctx context.Context, req *TurnRequest) (*StreamHandle, error) {
    llmReq := s.buildLLMRequest(req)

    // Start library stream
    stream, err := s.client.GenerateStream(ctx, s.provider, llmReq)
    if err != nil {
        return nil, err
    }

    return &StreamHandle{
        libraryStream: stream,
        chatID:        req.ChatID,
    }, nil
}
```

### Provider Selection (Business Logic)

```go
func (s *LLMService) SelectProvider(req *TurnRequest) (string, error) {
    // Business rule: Use specific provider for certain features
    if req.RequiresWebSearch {
        // Prefer providers with native search
        return "anthropic", nil  // web_search_20250305
    }

    if req.RequiresCodeExec {
        return "gemini", nil  // code_execution
    }

    // Default to configured provider
    return s.provider, nil
}
```

## Supported Providers

**Current Status (Backend Integration):**
- ✅ **Anthropic** - Fully integrated with provider factory and routing
- ✅ **OpenRouter** - Fully integrated with provider factory and routing
- 🚧 **OpenAI** - Library code exists, backend integration pending
- 🚧 **Gemini** - Library code exists, backend integration pending

The `meridian-llm-go` library contains adapters for all providers below. The backend currently routes to Anthropic and OpenRouter via the provider factory pattern (see `backend/internal/service/llm/provider_factory.go`).

### Default Model

- **Provider:** `openrouter`
- **Model:** `moonshotai/kimi-k2-thinking` (Kimi K2 Thinking)

### Anthropic Claude (still supported)

**Provider String:** `"anthropic"`

**Example Models (non-exhaustive):**
- `claude-haiku-4-5-20251001` - Fast, cost-effective
- `claude-sonnet-4-5-20250514` - Balanced performance
- `claude-opus-4-5-20250514` - Most capable

**Built-in Tools:**
- ✅ `search` → `web_search_20250305` (server-executed)
- ✅ `code_exec` → `bash_20241022` (client-executed)
- ✅ `apply_patch` → `text_editor_20250728` (client-executed)

**Features:**
- ✅ Extended thinking (low/medium/high/effort budgets)
- ✅ Streaming
- ✅ Temperature/Top-p/Top-k sampling
- ✅ Custom tools (Pattern A)

### OpenAI (Library Implementation)

**Provider String:** `"openai"`

**Supported Models:**
- `gpt-4o` - Most capable
- `gpt-4o-mini` - Fast and efficient
- `o1-preview` - Advanced reasoning
- `o1-mini` - Reasoning on budget

**Built-in Tools:**
- ✅ `code_exec` → `code_interpreter` (server-executed)

**Features:**
- ✅ Basic thinking support
- ✅ Streaming
- ✅ Custom tools (function calling)

### Google Gemini (Library Implementation)

**Provider String:** `"gemini"`

**Supported Models:**
- `gemini-2.0-flash-exp` - Fast preview
- `gemini-exp-1206` - Advanced capabilities

**Built-in Tools:**
- ✅ `search` → `google_search` (server-executed)
- ✅ `web_fetch` → `url_context` (server-executed)
- ✅ `code_exec` → `code_execution` (server-executed)

**Features:**
- ✅ Dynamic thinking (effort=-1)
- ✅ Streaming
- ✅ Custom tools (compositional)

### OpenRouter (Library Implementation)

**Provider String:** `"openrouter"`

**Supported Models:**
- Proxies to any supported model (Anthropic, OpenAI, Gemini, etc.)

**Built-in Tools:**
- ✅ `search` → plugin `web` (server-executed)

**Features:**
- ✅ Multi-provider access
- ✅ Model fallback support
- ✅ Streaming

## Backend Configuration

Provider selection and configuration happen in the backend:

### Environment Variables

```env
# Backend provider selection
LLM_PROVIDER=anthropic  # Default provider

# Provider API keys (library uses these)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
OPENROUTER_API_KEY=sk-or-...
```

### Capability Configs (Optional Overrides)

The library embeds default capability configs, but backends can override:

```
backend/
├── config/
│   └── capabilities/
│       ├── anthropic.yaml   # Optional overrides
│       ├── openai.yaml
│       ├── gemini.yaml
│       └── openrouter.yaml
```

**Example override:**
```yaml
# backend/config/capabilities/anthropic.yaml
models:
  claude-sonnet-4-5:
    input_price_per_mtok: 3.00    # Enterprise pricing
    output_price_per_mtok: 15.00
```

**See:** [`_docs/technical/llm/capability-loading.md`](../../llm/capability-loading.md) for config loading details

## Error Handling

The library returns normalized errors across all providers:

### Normalized LLMError

```go
// File: meridian-llm-go/errors.go

type LLMError struct {
    Category  ErrorCategory
    Message   string
    Provider  string
    Retryable bool
    Original  error  // Original provider error
}

type ErrorCategory string

const (
    ErrorRateLimit           ErrorCategory = "rate_limit"
    ErrorProviderOverloaded  ErrorCategory = "provider_overloaded"
    ErrorInvalidRequest      ErrorCategory = "invalid_request"
    ErrorModelNotSupported   ErrorCategory = "model_not_supported"
    ErrorProviderError       ErrorCategory = "provider_error"
    ErrorNetworkError        ErrorCategory = "network_error"
)
```

### Backend Error Handling

```go
func (s *LLMService) handleError(err error) error {
    var llmErr *llm.LLMError
    if !errors.As(err, &llmErr) {
        return err  // Unknown error
    }

    // Log with category and provider info
    s.logger.Error("LLM error",
        "category", llmErr.Category,
        "provider", llmErr.Provider,
        "retryable", llmErr.Retryable,
        "message", llmErr.Message,
    )

    // Return user-friendly message
    return fmt.Errorf("AI service error: %s", s.formatUserError(llmErr))
}

func (s *LLMService) formatUserError(err *llm.LLMError) string {
    switch err.Category {
    case llm.ErrorRateLimit:
        return "Too many requests. Please wait a moment and try again."
    case llm.ErrorProviderOverloaded:
        return "The AI service is temporarily overloaded. Please try again shortly."
    default:
        return err.Message
    }
}
```

**See:** [`_docs/technical/llm/error-normalization.md`](../../llm/error-normalization.md) for complete error handling

## Tool Execution

The backend implements **Pattern A** (consumer-side tool execution loop):

### Tools Example

```go
// Backend defines tools: mix of built-in (auto-mapped) and custom
tools := []llm.Tool{
    // Built-in tools (minimal definition - auto-maps to provider implementation)
    {Name: "web_search"},
    {Name: "bash"},

    // Custom tool (explicit type + full definition)
    {
        Type:          llm.ToolTypeCustom,
        Name:          "get_document",
        Category:      llm.ToolCategoryCustom,
        ExecutionSide: llm.ExecutionSideClient,
        Config: &llm.CustomToolConfig{
            Description: "Retrieve a document by ID",
            InputSchema: map[string]interface{}{
                "type": "object",
                "properties": map[string]interface{}{
                    "doc_id": {"type": "string"},
                },
            },
        },
    },
}

// Tool execution loop (backend responsibility)
maxIterations := 10
for i := 0; i < maxIterations; i++ {
    resp, err := s.client.GenerateResponse(ctx, s.provider, req)
    if err != nil {
        return nil, err
    }

    // Extract tool calls
    toolCalls := s.extractToolCalls(resp.Blocks)
    if len(toolCalls) == 0 {
        return resp, nil  // Done!
    }

    // Execute tools locally
    toolResults, err := s.executeTools(ctx, toolCalls)
    if err != nil {
        return nil, err
    }

    // Add results back to conversation
    req.Messages = append(req.Messages, llm.Message{
        Role:   "user",
        Blocks: toolResults,
    })
}
```

**Tool Auto-Mapping:**

- **Built-in tools** (`web_search`, `bash`, `text_editor`): Use minimal definition `{Name: "tool_name"}` - library auto-maps to provider implementation
- **Custom tools**: Must use `Type: ToolTypeCustom` with full definition (Description, InputSchema)

**See:**
- [`meridian-llm-go/docs/tools.md`](../../../meridian-llm-go/docs/tools.md) for complete tool guide
- [`_docs/technical/backend/llm-integration.md`](../llm-integration.md) for complete backend integration guide

## References

### Library Documentation
- **[LLM Library README](../../llm/README.md)** - Library overview
- **[Architecture](../../llm/architecture.md)** - 3-layer design
- **[Tool Mapping](../../llm/unified-tool-mapping.md)** - Tool execution patterns
- **[Error Normalization](../../llm/error-normalization.md)** - Error handling
- **[Capability Configuration](../../llm/capability-config-schema.md)** - Capability schema
- **[Capability Loading](../../llm/capability-loading.md)** - Config loading strategy

### Backend Integration
- **[Backend Integration Guide](../llm-integration.md)** - Complete integration patterns
- **[Streaming Integration](../streaming/README.md)** - Streaming infrastructure
- **[Tool Execution](../../llm/streaming/tool-execution.md)** - Tool execution details

### Implementation Plan
- **[V5 Plan](_docs/hidden/handoffs/llm-provider-unification-plan-v5.md)** - Complete implementation plan (6 phases)
