# Phase 2: Provider Migration — Lorem, Anthropic, OpenRouter

## Scope

Migrate all three providers to return `*Stream` instead of `<-chan StreamEvent`. Update the example binary.

## Design Spec

Provider migration pattern is in `.meridian/work/v1-launch/features/middleware/stream-type-final.md` under "Provider Migration Pattern". The Lorem before/after diff shows the exact pattern.

## Files to Modify

### Lorem Provider (reference implementation — do this first)
- `meridian-llm-go/providers/lorem/provider.go` — Change `StreamResponse` return type. Add `ctx, cancel := context.WithCancel(ctx)`. Add panic recovery defer in goroutine. Return `NewStreamFromChan(ctx, eventChan, cancel)`.

### Anthropic Provider
- `meridian-llm-go/providers/anthropic/streaming.go` — Same migration pattern. The existing goroutine structure stays. Add child context + cancel. Add panic recovery defer. Return `NewStreamFromChan(ctx, eventChan, cancel)`. The inner SDK reader goroutine should also get panic recovery.

### OpenRouter Provider
- `meridian-llm-go/providers/openrouter/streaming.go` — Same migration. This has a more complex goroutine structure (possibly multiple streaming paths). Apply the same pattern to each `StreamResponse` method.
- `meridian-llm-go/providers/openrouter/responses_streaming.go` — If this file has its own `StreamResponse`, apply the same migration. Keep emitting in-band `StreamEvent.Error` — that's correct, `NewStreamFromChan` converts them.

### Example
- `meridian-llm-go/examples/middleware-metering/main.go` — Update from `for ev := range stream` to `for stream.Next() { ev := stream.Event() }` + `stream.Err()` check.

### Provider Tests
- `meridian-llm-go/providers/lorem/provider_test.go` — Update stream consumption from channel range to Next()/Event()/Err() pattern.

## Migration Pattern (apply to each provider)

```go
// Before
func (p *Provider) StreamResponse(ctx context.Context, req *llmprovider.GenerateRequest) (<-chan llmprovider.StreamEvent, error) {
    eventChan := make(chan llmprovider.StreamEvent, 10)
    go func() {
        defer close(eventChan)
        // ...
    }()
    return eventChan, nil
}

// After
func (p *Provider) StreamResponse(ctx context.Context, req *llmprovider.GenerateRequest) (*llmprovider.Stream, error) {
    ctx, cancel := context.WithCancel(ctx)
    eventChan := make(chan llmprovider.StreamEvent, 10)
    go func() {
        defer close(eventChan)
        defer func() {
            if r := recover(); r != nil {
                eventChan <- llmprovider.StreamEvent{Error: llmprovider.NewStreamPanicError(r)}
            }
        }()
        // ... existing logic unchanged ...
    }()
    return llmprovider.NewStreamFromChan(ctx, eventChan, cancel), nil
}
```

**Critical**: The `recover()` defer must run BEFORE `close(eventChan)` — defers are LIFO, so `recover` must be deferred AFTER `close`.

## Verification Criteria

- [ ] `cd meridian-llm-go && go build ./...` compiles cleanly
- [ ] `cd meridian-llm-go && go test ./... -count=1` all pass
- [ ] `cd meridian-llm-go && go test ./... -count=1 -race` no races
- [ ] `cd meridian-llm-go && go vet ./...` passes
- [ ] `cd meridian-llm-go && make examples` builds all examples
- [ ] Lorem provider test exercises Next()/Event()/Err() pattern
