# Phase R3: Token Estimation (Tiktoken-Only)

## Scope
Create a `TokenEstimator` interface with a single tiktoken implementation. No API calls, no fallback chain, no caching.

## Intent
CM2 (token monitor) needs token estimation to trigger autocollapse (60%) and autocompact (80%). 5% variance from tiktoken is acceptable for these thresholds.

## Files to Create
- `backend/internal/service/llm/tokens/estimator.go` — interface + tiktoken implementation
- `backend/internal/service/llm/tokens/estimator_test.go` — unit tests with known token counts

## Files to Modify
- None — this is purely additive

## Interface Contract

```go
type TokenEstimator interface {
    EstimateRequest(ctx context.Context, req EstimateRequest) (*TokenEstimate, error)
    EstimateText(text string) int
}

type EstimateRequest struct {
    Model        string
    SystemPrompt string
    Messages     []Message // simplified message representation
    Tools        []Tool    // tool definitions
}

type TokenEstimate struct {
    SystemTokens   int
    MessageTokens  int
    ToolTokens     int
    TotalInput     int
    ContextWindow  int     // from CapabilityRegistry
    MaxOutput      int     // from CapabilityRegistry
    RemainingInput int     // ContextWindow - TotalInput - MaxOutput
    UsagePercent   float64 // TotalInput / (ContextWindow - MaxOutput)
}
```

### Implementation: tiktokenEstimator
- Uses `tiktoken-go` with `cl100k_base` encoding
- Wire with `CapabilityRegistry` for ContextWindow/MaxOutput lookups per model
- `EstimateText`: simple token count for a string
- `EstimateRequest`: sum of system + messages + tools token counts, compute remaining and percentage

## Dependencies
- `github.com/pkoukk/tiktoken-go` (add to go.mod)
- `capabilities/registry.go` for model context window and max output lookups

## Constraints
- No external API calls
- No estimator registry or fallback chain
- No caching layer
- Single encoding (`cl100k_base`) for all models

## Verification Criteria
- [ ] `make test` passes
- [ ] Unit tests for tiktoken estimator with known token counts (e.g., "hello world" = known count)
- [ ] UsagePercent calculated correctly against model's ContextWindow
- [ ] `go vet ./...` clean
- [ ] No external API calls made
- [ ] RemainingInput = ContextWindow - TotalInput - MaxOutput
