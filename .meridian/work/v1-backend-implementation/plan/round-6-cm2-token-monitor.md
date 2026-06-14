# Phase CM2: Token Monitor + Autocollapse

## Scope
Create TokenMonitor that checks budget after turn completion, triggers autocollapse at 60%.

## Files to Create
- `backend/internal/service/llm/streaming/token_monitor.go`
- `backend/internal/service/llm/streaming/token_monitor_test.go`

## Files to Modify
- `backend/internal/service/llm/streaming/stream_executor.go` — call TokenMonitor after turn completion

## Key Details
TokenMonitor takes TokenEstimator + CapabilityRegistry.

```go
type BudgetCheck struct {
    ShouldCollapse bool   // >= 60%
    ShouldCompact  bool   // >= 80%
    ShouldWarn     bool   // >= 90%
    UsagePercent   float64
}
```

After turn completion in stream_executor: call CheckBudget. If ShouldCollapse → create collapse marker turn (system turn with type="collapse_marker"). Context warning → emit SSE event `{"type": "context_warning", "usage_percent": N}`.

Monitor must NOT block turn completion (fast or async).

## Verification Criteria
- [ ] Below 60% → no action
- [ ] At 60% → ShouldCollapse=true
- [ ] At 80% → ShouldCompact=true
- [ ] At 90% → ShouldWarn=true
- [ ] Collapse marker turn created when threshold hit
- [ ] `make test` passes, `go vet ./...` clean
