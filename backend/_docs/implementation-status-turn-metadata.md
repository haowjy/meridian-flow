# Turn Metadata Implementation Status

**Feature:** Add comprehensive LLM request/response metadata tracking using JSONB

**Date:** 2025-11-09

---

## ✅ Completed (Steps 1-4)

### 1. Database Migration
**File:** `migrations/00002_add_turn_metadata.sql`

Added JSONB columns to turns table:
- `request_params JSONB` - All request parameters (temperature, max_tokens, thinking settings, etc.)
- `stop_reason TEXT` - Why generation stopped (separate column for indexing)
- `response_metadata JSONB` - Provider-specific response data

Includes GIN indexes for efficient JSONB querying.

### 2. Request Params Schema
**File:** `internal/domain/models/llm/request_params.go`

Created comprehensive `RequestParams` struct with:
- **Core params:** model, max_tokens, temperature, top_p, top_k, stop, seed
- **Anthropic-specific:** thinking_enabled, thinking_level (low/medium/high), system
- **OpenAI-specific:** frequency_penalty, presence_penalty, logit_bias, response_format, etc.
- **Tool params:** tools, tool_choice, parallel_tool_calls
- **Provider routing:** provider, fallback_models

Includes:
- `ValidateRequestParams()` - Validates ranges and structure
- `GetRequestParamStruct()` - Unmarshals JSONB map to typed struct
- Helper methods: `GetMaxTokens()`, `GetTemperature()`, `GetThinkingBudgetTokens()`

**Thinking level mapping:**
- `"low"` → 2000 tokens
- `"medium"` → 5000 tokens
- `"high"` → 12000 tokens

### 3. Turn Model Updated
**File:** `internal/domain/models/llm/turn.go`

Added fields to Turn struct:
```go
RequestParams    map[string]interface{} // JSONB - raw client request
StopReason       *string                // TEXT - indexed for queries
ResponseMetadata map[string]interface{} // JSONB - provider response data
```

### 4. Provider Interface Updated
**File:** `internal/domain/services/llm/provider.go`

**GenerateRequest:**
- Replaced individual fields (MaxTokens, Temperature, System) with unified `Params *llm.RequestParams`

**GenerateResponse:**
- Added `ResponseMetadata map[string]interface{}` field

---

## 🔄 Remaining Implementation (Steps 5-9)

### 5. Update CreateTurnRequest
**File:** `internal/domain/services/llm/chat.go`

**Changes needed:**
```go
type CreateTurnRequest struct {
    ChatID        string
    UserID        string
    PrevTurnID    *string
    Role          string
    SystemPrompt  *string
    ContentBlocks []ContentBlockInput
    Model         string  // REMOVE or make optional - can be in request_params

    // ADD:
    RequestParams map[string]interface{} `json:"request_params,omitempty"`
}
```

**Questions:**
- Should `Model` field stay (for backward compatibility) or move entirely to `request_params`?
- If both are provided, which takes precedence?

**Recommendation:** Keep `Model` at top level (most common param), but allow override via `request_params["model"]`

---

### 6. Update Anthropic Adapter
**File:** `internal/service/llm/providers/anthropic/adapter.go`
**File:** `internal/service/llm/providers/anthropic/client.go`

**Changes needed in `client.go`:**

```go
func (p *Provider) GenerateResponse(ctx context.Context, req *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
    // Extract params (or use defaults)
    params := req.Params
    if params == nil {
        params = &llm.RequestParams{}
    }

    // Build Anthropic request
    maxTokens := params.GetMaxTokens(4096)

    apiParams := anthropic.MessageNewParams{
        Model:     anthropic.Model(req.Model),
        Messages:  messages,
        MaxTokens: int64(maxTokens),
    }

    // Temperature
    if params.Temperature != nil {
        apiParams.Temperature = anthropic.Float(*params.Temperature)
    }

    // Top-P
    if params.TopP != nil {
        apiParams.TopP = anthropic.Float(*params.TopP)
    }

    // Top-K
    if params.TopK != nil {
        apiParams.TopK = anthropic.Int(int64(*params.TopK))
    }

    // Stop sequences
    if len(params.Stop) > 0 {
        apiParams.StopSequences = params.Stop
    }

    // System prompt (from params or turn-level)
    system := ""
    if params.System != nil {
        system = *params.System
    }
    // ... existing system prompt logic

    // THINKING - NEW FEATURE
    if params.ThinkingEnabled != nil && *params.ThinkingEnabled {
        budgetTokens := params.GetThinkingBudgetTokens()
        if budgetTokens > 0 {
            // Anthropic extended thinking params
            apiParams.Thinking = anthropic.ThinkingParams{
                Type:   "enabled",
                Budget: budgetTokens,
            }
        }
    }

    // Call API...
    message, err := p.client.Messages.New(ctx, apiParams)

    // Build response metadata
    responseMetadata := make(map[string]interface{})
    if message.StopSequence != "" {
        responseMetadata["stop_sequence"] = message.StopSequence
    }
    if message.Usage.CacheCreationInputTokens > 0 {
        responseMetadata["cache_creation_input_tokens"] = message.Usage.CacheCreationInputTokens
    }
    if message.Usage.CacheReadInputTokens > 0 {
        responseMetadata["cache_read_input_tokens"] = message.Usage.CacheReadInputTokens
    }

    return &domainllm.GenerateResponse{
        Content:          blocks,
        Model:            string(message.Model),
        InputTokens:      int(message.Usage.InputTokens),
        OutputTokens:     int(message.Usage.OutputTokens),
        StopReason:       string(message.StopReason),
        ResponseMetadata: responseMetadata,
    }, nil
}
```

**Questions:**
- Do we need to check Anthropic SDK version for extended thinking support?
- Should we validate thinking_level before sending, or let Anthropic error?

---

### 7. Update ResponseGenerator
**File:** `internal/service/llm/response_generator.go`

**Changes needed:**

```go
func (g *ResponseGenerator) GenerateResponse(
    ctx context.Context,
    userTurnID string,
    model string,
    requestParams map[string]interface{},  // NEW parameter
) (*domainllm.GenerateResponse, error) {

    // Validate and parse request params
    if err := llm.ValidateRequestParams(requestParams); err != nil {
        return nil, fmt.Errorf("invalid request params: %w", err)
    }

    params, err := llm.GetRequestParamStruct(requestParams)
    if err != nil {
        return nil, fmt.Errorf("failed to parse request params: %w", err)
    }

    // Override model if specified in params
    if params.Model != nil {
        model = *params.Model
    }

    // Get conversation path (existing logic)
    path, err := g.turnRepo.GetTurnPath(ctx, userTurnID)
    // ...

    // Build messages (existing logic)
    messages, err := g.buildMessages(path)
    // ...

    // Get provider
    provider, err := g.registry.GetProvider(model)
    // ...

    // Generate response with params
    req := &domainllm.GenerateRequest{
        Messages: messages,
        Model:    model,
        Params:   params,  // Pass unified params
    }

    response, err := provider.GenerateResponse(ctx, req)
    // ...

    return response, nil
}
```

**Signature change affects:**
- `internal/service/llm/chat.go` (ChatService.CreateTurn)

---

### 8. Update ChatService
**File:** `internal/service/llm/chat.go`

**Changes in `CreateTurn` method:**

```go
func (s *chatService) CreateTurn(ctx context.Context, req *llmSvc.CreateTurnRequest) (*llmModels.Turn, error) {
    // ... existing validation and user turn creation ...

    // Merge request params with defaults
    requestParams := req.RequestParams
    if requestParams == nil {
        requestParams = make(map[string]interface{})
    }

    // Set model if not in params
    if _, hasModel := requestParams["model"]; !hasModel && req.Model != "" {
        requestParams["model"] = req.Model
    }

    // Use default model if neither specified
    model := req.Model
    if model == "" {
        if modelParam, ok := requestParams["model"].(string); ok {
            model = modelParam
        } else {
            model = "claude-haiku-4-5-20251001"
        }
    }

    // Generate LLM response with params
    response, err := s.responseGenerator.GenerateResponse(ctx, turn.ID, model, requestParams)
    if err != nil {
        s.logger.Error("failed to generate LLM response", "error", err)
        return turn, fmt.Errorf("LLM generation failed: %w", err)
    }

    // Create assistant turn with full metadata
    assistantTurn, err := s.CreateAssistantTurnDebug(
        ctx,
        req.ChatID,
        req.UserID,
        &turn.ID,
        contentBlocks,
        response.Model,
    )
    // ...

    // Update assistant turn with metadata
    assistantTurn.Status = "complete"
    assistantTurn.InputTokens = &response.InputTokens
    assistantTurn.OutputTokens = &response.OutputTokens
    assistantTurn.StopReason = &response.StopReason

    // Store request params and response metadata
    assistantTurn.RequestParams = requestParams
    assistantTurn.ResponseMetadata = response.ResponseMetadata

    if err := s.turnRepo.UpdateTurn(ctx, assistantTurn); err != nil {
        s.logger.Error("failed to update assistant turn", "error", err)
    }

    // ...
}
```

---

### 9. Update Repository
**File:** `internal/repository/postgres/llm/turn.go`

**Changes in `CreateTurn`:**

```go
func (r *PostgresTurnRepository) CreateTurn(ctx context.Context, turn *llmModels.Turn) error {
    query := fmt.Sprintf(`
        INSERT INTO %s (
            chat_id, prev_turn_id, role, system_prompt, status, error,
            model, input_tokens, output_tokens,
            created_at, completed_at,
            request_params, stop_reason, response_metadata  -- NEW
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id, created_at
    `, r.tables.Turns)

    err := executor.QueryRow(ctx, query,
        turn.ChatID,
        turn.PrevTurnID,
        turn.Role,
        turn.SystemPrompt,
        turn.Status,
        turn.Error,
        turn.Model,
        turn.InputTokens,
        turn.OutputTokens,
        turn.CreatedAt,
        turn.CompletedAt,
        turn.RequestParams,    // JSONB
        turn.StopReason,       // TEXT
        turn.ResponseMetadata, // JSONB
    ).Scan(&turn.ID, &turn.CreatedAt)
    // ...
}
```

**Changes in `UpdateTurn`:**

```go
func (r *PostgresTurnRepository) UpdateTurn(ctx context.Context, turn *llmModels.Turn) error {
    query := fmt.Sprintf(`
        UPDATE %s
        SET status = $1, model = $2, input_tokens = $3, output_tokens = $4,
            completed_at = $5, error = $6,
            request_params = $7, stop_reason = $8, response_metadata = $9  -- NEW
        WHERE id = $10
    `, r.tables.Turns)

    result, err := executor.Exec(ctx, query,
        turn.Status,
        turn.Model,
        turn.InputTokens,
        turn.OutputTokens,
        turn.CompletedAt,
        turn.Error,
        turn.RequestParams,    // JSONB
        turn.StopReason,       // TEXT
        turn.ResponseMetadata, // JSONB
        turn.ID,
    )
    // ...
}
```

**Changes in `GetTurn` and `GetTurnPath`:**

Need to scan new JSONB columns:
```go
var turn llmModels.Turn
err := row.Scan(
    &turn.ID,
    &turn.ChatID,
    // ... existing fields ...
    &turn.RequestParams,    // ADD
    &turn.StopReason,       // ADD
    &turn.ResponseMetadata, // ADD
)
```

---

## Testing Plan

### 1. Database Migration
```bash
# Run migration
goose -dir migrations postgres $SUPABASE_DB_URL up

# Or via make (if configured)
make migrate-up
```

### 2. Basic Request (No Params)
```bash
curl -X POST http://localhost:8080/api/chats/:id/turns \
  -H "Content-Type: application/json" \
  -d '{
    "role": "user",
    "content_blocks": [
      {"block_type": "text", "text_content": "Hello"}
    ]
  }'
```
**Expected:** Uses defaults, assistant turn has minimal request_params

### 3. Request with Temperature
```bash
curl -X POST http://localhost:8080/api/chats/:id/turns \
  -H "Content-Type: application/json" \
  -d '{
    "role": "user",
    "content_blocks": [
      {"block_type": "text", "text_content": "Write a poem"}
    ],
    "request_params": {
      "temperature": 0.9,
      "max_tokens": 500
    }
  }'
```
**Expected:** Assistant turn stores `{"temperature": 0.9, "max_tokens": 500}` in request_params

### 4. Request with Thinking
```bash
curl -X POST http://localhost:8080/api/chats/:id/turns \
  -H "Content-Type: application/json" \
  -d '{
    "role": "user",
    "content_blocks": [
      {"block_type": "text", "text_content": "Solve this complex problem..."}
    ],
    "request_params": {
      "thinking_enabled": true,
      "thinking_level": "high"
    }
  }'
```
**Expected:**
- Anthropic receives budget_tokens: 12000
- Assistant turn has thinking blocks in content
- response_metadata shows thinking usage

### 5. Verify Database
```sql
-- Check request params stored
SELECT id, role, request_params, stop_reason, response_metadata
FROM turns
WHERE role = 'assistant'
ORDER BY created_at DESC
LIMIT 5;

-- Query by temperature
SELECT id, request_params->>'temperature' as temp
FROM turns
WHERE (request_params->>'temperature')::float > 0.5;

-- Check stop reasons
SELECT stop_reason, COUNT(*)
FROM turns
WHERE stop_reason IS NOT NULL
GROUP BY stop_reason;
```

---

## Open Questions / Decisions Needed

### 1. Model Field Duplication
- Keep `Model` as top-level field in CreateTurnRequest for convenience?
- Or require clients to always put it in request_params?
- **Current plan:** Keep both, request_params takes precedence

### 2. Backward Compatibility
- Old clients won't send request_params - should work with defaults ✅
- Old turns in DB will have NULL for new columns - queries should handle ✅

### 3. Validation Strictness
- Currently: Validate param ranges, ignore unsupported params per provider
- Alternative: Strict validation per provider (more complex)
- **Current plan:** Lenient validation (easier to add providers)

### 4. Extended Thinking Support
- Anthropic API for extended thinking may differ from assumptions
- Need to verify actual API when implementing
- May need to adjust `ThinkingParams` structure

### 5. Migration Timing
- Should migration run automatically on server start?
- Or manual `goose up` step?
- **Current plan:** Manual migration (safer for production)

---

## Estimated Effort

| Step | Complexity | Time |
|------|------------|------|
| 5. CreateTurnRequest | Low | 15 min |
| 6. Anthropic Adapter | Medium | 45 min |
| 7. ResponseGenerator | Low | 20 min |
| 8. ChatService | Medium | 30 min |
| 9. Repository | Low | 30 min |
| Testing & Debugging | Medium | 60 min |
| **Total** | | **~3 hours** |

---

## Next Steps

1. **Review this document** - Approve approach and decisions
2. **Implement steps 5-9** - Complete the remaining code changes
3. **Run migration** - Update database schema
4. **Test end-to-end** - Verify with curl requests
5. **Document usage** - Add examples to API docs

---

## Files Modified Summary

### Created:
- `migrations/00002_add_turn_metadata.sql`
- `internal/domain/models/llm/request_params.go`

### Modified:
- `internal/domain/models/llm/turn.go` ✅
- `internal/domain/services/llm/provider.go` ✅
- `internal/domain/services/llm/chat.go` (pending)
- `internal/service/llm/providers/anthropic/client.go` (pending)
- `internal/service/llm/providers/anthropic/adapter.go` (pending)
- `internal/service/llm/response_generator.go` (pending)
- `internal/service/llm/chat.go` (pending)
- `internal/repository/postgres/llm/turn.go` (pending)
