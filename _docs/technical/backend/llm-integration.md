---
detail: standard
audience: developer
---

# Backend LLM Integration Guide

**Purpose:** How the Meridian backend integrates with `meridian-llm-go` library.

---

## Overview

The backend acts as a **consumer** of the `meridian-llm-go` library:
- Service layer initializes LLM client
- Implements custom tool execution
- Handles tool execution loop (Pattern A)
- Provides business logic for provider selection
- Manages retry strategies

**For library documentation**, see [`../llm/README.md`](../llm/README.md).

---

## Service Layer Structure

```
backend/internal/service/llm/
├── service.go          # Main LLM service
├── tool_registry.go    # Custom tool registration (PLANNED)
├── tool_executor.go    # Tool execution logic (PLANNED)
└── retry.go            # Retry strategies (PLANNED)
```

---

## Initialization

### 1. Library Setup

```go
// File: backend/internal/service/llm/service.go

type LLMService struct {
    client   *llm.LLMClient
    provider string  // "anthropic", "openai", etc.
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

### 2. Capability Configuration

**Where capability files live:**

```
backend/
├── config/
│   └── capabilities/
│       ├── anthropic.yaml
│       ├── openai.yaml
│       ├── gemini.yaml
│       └── openrouter.yaml
```

**Loading strategy:**
- Library ships with default embedded capabilities
- Backend can override by passing `configDir` to `NewLLMClient()`
- Library loads from `{configDir}/capabilities/*.yaml`
- If file not found, uses embedded defaults

**Backend configuration (optional overrides):**

```yaml
# backend/config/capabilities/anthropic.yaml
models:
  claude-sonnet-4-5:
    input_price_per_mtok: 3.00    # Override if pricing changes
    output_price_per_mtok: 15.00
```

**Most backends don't need custom capability files** - use library defaults and only override when necessary (e.g., custom pricing for enterprise contracts).

**See:** [`../llm/capability-loading.md`](../llm/capability-loading.md) for config loading details.

---

## Basic Usage

### Generate Response

```go
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

    // Call library
    resp, err := s.client.GenerateResponse(ctx, s.provider, req)
    if err != nil {
        return nil, s.handleError(err)
    }

    // Convert library blocks to domain Turn
    return s.convertToTurn(chatID, resp), nil
}
```

---

## Streaming Integration

### 1. Start Stream

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

### 2. Process Stream Events

```go
func (h *StreamHandle) ProcessEvents(handler EventHandler) error {
    for event := range h.libraryStream.Events() {
        if event.Error != nil {
            return event.Error
        }

        // Convert library block to domain TurnBlockDelta
        delta := convertBlockDelta(event.Block)

        // Send to SSE handler
        if err := handler.SendDelta(delta); err != nil {
            return err
        }
    }

    return nil
}
```

**See:** [`../llm/streaming/README.md`](../llm/streaming/README.md) for streaming architecture.

---

## Custom Tools (PLANNED)

### Tool Registry

```go
// File: backend/internal/service/llm/tool_registry.go

type ToolRegistry struct {
    tools map[string]ToolExecutor
}

type ToolExecutor interface {
    Execute(ctx context.Context, input map[string]interface{}) (interface{}, error)
}

func NewToolRegistry(
    documentRepo repository.DocumentRepository,
    treeRepo repository.TreeRepository,
) *ToolRegistry {
    registry := &ToolRegistry{
        tools: make(map[string]ToolExecutor),
    }

    // Register custom tools
    registry.Register("get_document", &GetDocumentTool{repo: documentRepo})
    registry.Register("get_tree", &GetTreeTool{repo: treeRepo})
    registry.Register("search_documents", &SearchDocumentsTool{repo: documentRepo})

    return registry
}
```

### Tool Execution

```go
// File: backend/internal/service/llm/tool_executor.go

func (s *LLMService) GenerateTurnWithTools(ctx context.Context, req *TurnRequest) (*Turn, error) {
    llmReq := &llm.GenerateRequest{
        Model:    req.Model,
        Messages: s.convertMessages(req.Messages),
        Params: llm.RequestParams{
            // Tools: Mix of built-in (auto-mapped) and custom
            Tools: []llm.Tool{
                // Built-in tools (auto-map to provider-specific implementation)
                {Name: "web_search"},
                {Name: "bash"},

                // Custom tool (explicitly marked as custom)
                {
                    Type:        llm.ToolTypeCustom,
                    Name:        "get_document",
                    Description: "Retrieve a document by ID",
                    InputSchema: map[string]interface{}{
                        "type": "object",
                        "properties": map[string]interface{}{
                            "doc_id": {"type": "string"},
                        },
                    },
                },
            },
        },
    }

    // Tool execution loop (Pattern A)
    maxIterations := 10
    for i := 0; i < maxIterations; i++ {
        resp, err := s.client.GenerateResponse(ctx, s.provider, llmReq)
        if err != nil {
            return nil, err
        }

        // Extract tool calls from response
        toolCalls := s.extractToolCalls(resp.Blocks)
        if len(toolCalls) == 0 {
            // No tool calls - done!
            return s.convertToTurn(req.ChatID, resp), nil
        }

        // Execute tools
        toolResults, err := s.executeTools(ctx, toolCalls)
        if err != nil {
            return nil, err
        }

        // Add tool results to conversation
        llmReq.Messages = append(llmReq.Messages, llm.Message{
            Role:   "user",
            Blocks: toolResults,
        })
    }

    return nil, fmt.Errorf("max tool iterations reached")
}

func (s *LLMService) executeTools(ctx context.Context, calls []ToolCall) ([]*llm.Block, error) {
    results := []*llm.Block{}

    for _, call := range calls {
        // Look up executor from registry
        executor, exists := s.toolRegistry.Get(call.ToolName)
        if !exists {
            results = append(results, &llm.Block{
                BlockType: "tool_result",
                Content: map[string]interface{}{
                    "tool_use_id": call.ID,
                    "is_error":    true,
                    "content":     fmt.Sprintf("Unknown tool: %s", call.ToolName),
                },
            })
            continue
        }

        // Execute tool
        result, err := executor.Execute(ctx, call.Input)
        if err != nil {
            results = append(results, &llm.Block{
                BlockType: "tool_result",
                Content: map[string]interface{}{
                    "tool_use_id": call.ID,
                    "is_error":    true,
                    "content":     err.Error(),
                },
            })
        } else {
            results = append(results, &llm.Block{
                BlockType: "tool_result",
                Content: map[string]interface{}{
                    "tool_use_id": call.ID,
                    "is_error":    false,
                    "content":     result,
                },
            })
        }
    }

    return results, nil
}
```

**Tool Auto-Mapping:**

Built-in tools (`web_search`, `bash`, `text_editor`) can be specified with just `{Name: "tool_name"}` - the library automatically maps them to provider-specific implementations.

Custom tools must use `Type: ToolTypeCustom` and provide full definition (Description, InputSchema).

**See:**
- [`meridian-llm-go/docs/tools.md`](../../meridian-llm-go/docs/tools.md) for complete tool guide
- [`../llm/unified-tool-mapping.md`](../llm/unified-tool-mapping.md) Section 2.5 for auto-mapping details
- [`../llm/unified-tool-mapping.md`](../llm/unified-tool-mapping.md) Section 4.5 for tool execution pattern

---

## Error Handling

### Normalized Errors

Library returns `llm.LLMError` with normalized categories:

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

**See:** [`../llm/error-normalization.md`](../llm/error-normalization.md) for complete error handling.

---

## Retry Strategies (PLANNED)

### Exponential Backoff

```go
// File: backend/internal/service/llm/retry.go

func (s *LLMService) GenerateWithRetry(ctx context.Context, req *llm.GenerateRequest) (*llm.Response, error) {
    maxRetries := 3
    baseDelay := 1 * time.Second

    for attempt := 0; attempt <= maxRetries; attempt++ {
        resp, err := s.client.GenerateResponse(ctx, s.provider, req)
        if err == nil {
            return resp, nil
        }

        // Check if retryable
        var llmErr *llm.LLMError
        if !errors.As(err, &llmErr) || !llmErr.Retryable {
            return nil, err  // Don't retry
        }

        // Last attempt failed
        if attempt == maxRetries {
            return nil, llmErr
        }

        // Calculate delay
        delay := baseDelay * time.Duration(1<<attempt)
        if llmErr.Category == llm.ErrorRateLimit {
            delay = 10 * time.Second * time.Duration(1<<attempt)
        }

        // Wait before retry
        select {
        case <-time.After(delay):
            continue
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }

    return nil, fmt.Errorf("max retries exceeded")
}
```

---

## Provider Selection

### Automatic Routing

Backend routes model strings to providers via **factory pattern**:

```
Model: "claude-haiku-4-5" → Parser → {provider: "anthropic"} → Factory → Anthropic Provider
```

**Status:**
- ✅ Anthropic: Fully implemented
- 🚧 OpenAI, Gemini, OpenRouter: Library exists, factory pending

**Implementation:** `backend/internal/service/llm/provider_factory.go`

**See:** [Provider Routing](provider-routing.md) for complete routing architecture

### Business Logic (Future)

```go
func (s *LLMService) SelectProvider(req *TurnRequest) (string, error) {
    // Example: Feature-based routing
    if req.RequiresWebSearch {
        return "anthropic", nil  // web_search_20250305
    }
    return s.defaultProvider, nil
}
```

---

## Conversion Helpers

### Domain Models ↔ Library Blocks

```go
func (s *LLMService) convertToTurn(chatID string, resp *llm.Response) *Turn {
    turn := &Turn{
        ChatID:    chatID,
        Role:      "assistant",
        Blocks:    make([]*TurnBlock, len(resp.Blocks)),
        CreatedAt: time.Now(),
    }

    for i, block := range resp.Blocks {
        turn.Blocks[i] = &TurnBlock{
            Sequence:  block.Sequence,
            BlockType: block.BlockType,
            Content:   block.Content,
        }
    }

    return turn
}

func (s *LLMService) convertMessages(messages []*Message) []llm.Message {
    llmMsgs := make([]llm.Message, len(messages))

    for i, msg := range messages {
        blocks := make([]*llm.Block, len(msg.Turns))
        for j, turn := range msg.Turns {
            blocks[j] = &llm.Block{
                BlockType: turn.BlockType,
                Sequence:  j,
                Content:   turn.Content,
            }
        }

        llmMsgs[i] = llm.Message{
            Role:   msg.Role,
            Blocks: blocks,
        }
    }

    return llmMsgs
}
```

---

## Testing

### Mock Library Client

```go
// File: backend/internal/service/llm/service_test.go

type MockLLMClient struct {
    mock.Mock
}

func (m *MockLLMClient) GenerateResponse(ctx context.Context, provider string, req *llm.GenerateRequest) (*llm.Response, error) {
    args := m.Called(ctx, provider, req)
    return args.Get(0).(*llm.Response), args.Error(1)
}

func TestGenerateTurn(t *testing.T) {
    mockClient := new(MockLLMClient)
    service := &LLMService{
        client:   mockClient,
        provider: "anthropic",
    }

    // Setup mock expectation
    mockClient.On("GenerateResponse", mock.Anything, "anthropic", mock.Anything).
        Return(&llm.Response{
            Blocks: []*llm.Block{
                {
                    BlockType: "text",
                    Content: map[string]interface{}{
                        "text": "Hello!",
                    },
                },
            },
        }, nil)

    // Test
    turn, err := service.GenerateTurn(context.Background(), "chat-123", "Hi")
    require.NoError(t, err)
    assert.Equal(t, "Hello!", turn.Blocks[0].Content["text"])
}
```

---

## Summary

**Backend responsibilities:**
1. Initialize library client with configs
2. Convert domain models ↔ library blocks
3. Implement custom tool executors
4. Handle tool execution loop (Pattern A)
5. Apply business logic (provider selection, retry strategies)
6. Format errors for users

**Library responsibilities:**
1. Provider abstraction and switching
2. Format translation (Block ↔ provider format)
3. Streaming infrastructure
4. Error normalization
5. Capability validation

**See Also:**
- [LLM Library README](../llm/README.md) - Library overview
- [Architecture](../llm/architecture.md) - 3-layer design
- [Tool Mapping](../llm/unified-tool-mapping.md) - Tool execution patterns
- [Error Normalization](../llm/error-normalization.md) - Error handling
- [Provider Routing](provider-routing.md) - Model string routing
- [Environment Gating](environment-gating.md) - Tool restrictions
