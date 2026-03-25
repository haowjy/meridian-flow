# Token Budget Tracking

Dry-run token estimation, context budget comparison, and threshold-based triggers for context management.

## Problem

The backend needs to know how many tokens will be sent BEFORE sending them, to:

1. **Trigger autocollapse** when approaching 60% of context window
2. **Trigger autocompact** when approaching 80% of context window
3. **Warn the user** when context is nearly full
4. **Show pre-action cost estimates** in the UI ("This will use ~15 credits")
5. **Validate persona system prompts** aren't unreasonably large
6. **Compare actual vs estimated** for billing accuracy

## Architecture

### Token Estimator (Library Layer)

Lives in `backend/internal/service/llm/tokens/` alongside existing `TokenCounter`.

```go
type EstimateRequest struct {
    Provider     string
    Model        string
    SystemPrompt string
    Messages     []Message     // Conversation history
    Tools        []ToolDef     // Tool definitions
}

type TokenEstimate struct {
    SystemTokens   int     // System prompt tokens
    MessageTokens  int     // Conversation history tokens
    ToolTokens     int     // Tool definition tokens
    TotalInput     int     // Sum of above
    ContextWindow  int     // Model's max context
    MaxOutput      int     // Model's max output
    AvailableInput int     // ContextWindow - TotalInput - MaxOutput
    UsagePercent   float64 // TotalInput / ContextWindow
}

type TokenEstimator interface {
    EstimateRequest(ctx context.Context, req EstimateRequest) (*TokenEstimate, error)
    EstimateText(ctx context.Context, provider, model, text string) (int, error)
    SupportsProvider(provider string) bool
}
```

### Provider Implementations

**Anthropic** (`anthropic_estimator.go`):
- Uses `POST /v1/messages/count_tokens` API
- Exact token count
- Rate-limited (separate from generation rate limits)
- Cache the estimate for unchanged prefixes (system prompt + early messages don't change between turns)

**Tiktoken fallback** (`tiktoken_estimator.go`):
- Uses `tiktoken-go` with `cl100k_base` encoding
- Works for any provider without a counting API
- ~5% variance from actual, good enough for thresholds
- Zero network calls

**Heuristic fallback** (`heuristic_estimator.go`):
- `chars / 4` approximation
- Only used when tiktoken isn't available for the model family
- ~15% variance, sufficient for "are we close to the limit" checks

### Estimator Registry

```go
type EstimatorRegistry struct {
    estimators []TokenEstimator // ordered by preference
}

func (r *EstimatorRegistry) Estimate(ctx context.Context, req EstimateRequest) (*TokenEstimate, error) {
    for _, e := range r.estimators {
        if e.SupportsProvider(req.Provider) {
            return e.EstimateRequest(ctx, req)
        }
    }
    return r.fallback.EstimateRequest(ctx, req)
}
```

Priority: Anthropic API → tiktoken → heuristic.

### Token Monitor (Application Layer)

Runs after each turn completion. Checks token budget and triggers context management.

```go
type TokenMonitor struct {
    estimator       EstimatorRegistry
    capRegistry     capabilities.Registry
    collapsePercent float64 // default 0.60
    compactPercent  float64 // default 0.80
    warnPercent     float64 // default 0.90
}

type BudgetCheck struct {
    Estimate       TokenEstimate
    ShouldCollapse bool
    ShouldCompact  bool
    ShouldWarn     bool
}

func (m *TokenMonitor) CheckBudget(ctx context.Context, req EstimateRequest) (*BudgetCheck, error)
```

### Integration Points

**After each turn completion** (stream_executor.go):
```
turn completes → TokenMonitor.CheckBudget() →
  if ShouldCollapse → place collapse bookmark
  if ShouldCompact → run compaction (haiku-class model)
  if ShouldWarn → emit SSE warning event
```

**Before turn creation** (turn_creation.go):
```
CreateTurn → estimate current context →
  if > 95% → reject with "context full, compact or start new thread"
```

**Pre-action cost estimate** (new handler):
```
GET /api/threads/{id}/token-estimate →
  returns current usage, remaining capacity, estimated cost for next turn
```

### Caching Strategy

Token estimates for unchanged content should be cached:
- System prompt tokens: cache keyed by hash(system_prompt), invalidate on persona switch
- Message history tokens: cache keyed by (thread_id, latest_turn_id), invalidate on new turn
- Tool tokens: cache keyed by hash(tool_definitions), invalidate on tool set change

Cache is in-memory, per-thread, evicted on thread switch. No persistence needed.

## meridian-llm-go Changes

The library may need a `CountTokens` method on the Provider interface:

```go
// Optional interface — providers implement if they have a counting API
type TokenCountingProvider interface {
    CountTokens(ctx context.Context, req *GenerateRequest) (*TokenCount, error)
}

type TokenCount struct {
    InputTokens int
}
```

This follows the existing optional interface pattern (like `GenerationCanceller`). Providers that don't support it return an error, and the backend falls back to tiktoken.

## API

### `GET /api/threads/{id}/context-budget`

Returns current context usage for the thread.

```json
{
  "model": "claude-sonnet-4-20250514",
  "context_window": 200000,
  "max_output": 8192,
  "current_usage": {
    "system_tokens": 1200,
    "message_tokens": 45000,
    "tool_tokens": 800,
    "total_input": 47000
  },
  "available_input": 144808,
  "usage_percent": 0.235,
  "thresholds": {
    "collapse_at": 0.60,
    "compact_at": 0.80,
    "warn_at": 0.90
  },
  "estimation_method": "anthropic_api"
}
```

## Non-Goals (v1)

- Real-time streaming token count display (too expensive to estimate per-chunk)
- Per-message token breakdown in the UI (can add post-v1)
- Custom threshold configuration per user (use sensible defaults)
- Token-based billing (we bill on actual usage from provider response, not estimates)
