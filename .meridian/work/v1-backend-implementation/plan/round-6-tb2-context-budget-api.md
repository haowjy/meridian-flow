# Phase TB2: Context Budget API Endpoint

## Scope
Read-only endpoint returning current token usage, thresholds, and estimation method.

## Files to Create
- `backend/internal/handler/context_budget.go`

## Files to Modify
- `backend/internal/app/domains/llm.go` — wire endpoint

## Key Details
GET /api/threads/{id}/context-budget → JSON response:
```json
{
  "model": "claude-sonnet-4-6",
  "context_window": 200000,
  "max_output": 8192,
  "total_input": 45000,
  "remaining_input": 146808,
  "usage_percent": 0.234,
  "thresholds": {
    "collapse": 0.60,
    "compact": 0.80,
    "warn": 0.90
  },
  "estimation_method": "tiktoken"
}
```

Uses TokenMonitor.CheckBudget() internally.

## Verification Criteria
- [ ] Endpoint returns JSON matching spec
- [ ] Includes model, context_window, usage_percent, thresholds
- [ ] estimation_method reports "tiktoken"
- [ ] `make test` passes, `go vet ./...` clean
