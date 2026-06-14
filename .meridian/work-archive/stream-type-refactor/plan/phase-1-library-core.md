# Phase 1: Library Core — Stream Type + Middleware Rewrite

## Scope

Create the pull-based `*Stream` type and update all library-level types to use it. This is the foundation everything else depends on.

## Design Spec

Full implementations are in `.meridian/work/v1-launch/features/middleware/stream-type-final.md`. Follow the code exactly — it has been through 6 review rounds.

## Files to Create

- `meridian-llm-go/stream.go` — `Stream` struct, `NewStream`, `StreamFromSlice`, `NewStreamFromChan`, `TransformStream`, `StreamInterceptor`, `StreamPanicError`, `NewStreamPanicError`, all internal state helpers (`chanStreamState`, `transformState`)

## Files to Modify

- `meridian-llm-go/streaming.go` — Update `StreamEvent.Error` comment to document it as "internal transport field: provider goroutine -> NewStreamFromChan only. Consumers of *Stream should ignore this and use stream.Err()." Do NOT change the struct fields themselves.
- `meridian-llm-go/provider.go` — Change `StreamResponse` return type from `(<-chan StreamEvent, error)` to `(*Stream, error)`. Update doc comments.
- `meridian-llm-go/middleware.go` — Change `StreamFunc` from `func(...) (<-chan StreamEvent, error)` to `func(...) (*Stream, error)`. Update `wrappedProvider.StreamResponse` return type. Update doc comments.
- `meridian-llm-go/usage_metering.go` — Complete rewrite of `WrapStream` to use `TransformStream` instead of proxy goroutines. Remove the entire proxy channel/goroutine pattern. The `WrapGenerate` method stays the same. Remove any channel-related imports that are no longer needed.

## Files to Update (Tests)

- `meridian-llm-go/middleware_test.go` — Update all tests from channel consumption (`for ev := range ch`) to `*Stream` pattern (`for s.Next() { ev := s.Event() }`). Update mock providers to return `*Stream`. Use `StreamFromSlice` for test helpers.
- `meridian-llm-go/usage_metering_test.go` — Same rewrite. All stream tests should use `StreamFromSlice` for inputs and `Next()/Event()/Err()` for consumption. Remove any proxy channel patterns.

## Key Implementation Notes

1. `Stream` is a simple struct with 4 function fields — not an interface. This is deliberate.
2. `NewStreamFromChan` uses a two-level select to prioritize channel reads over ctx.Done(). Copy this exactly from the design doc.
3. `TransformStream` recovers panics in both `next()` and `closeFn()`. The close panic recovery wraps ONLY the OnClose call, not upstream.Close().
4. `StreamFromSlice.errFn` preserves terminal error even after Close() — the `closed` check was intentionally removed per review.
5. `terminalOnce` ensures exactly one terminal state transition. This is the core serialization mechanism.
6. `stream_error_recovery.go` — do NOT delete this file yet. It may still be used by providers. Dead code cleanup is a later phase.

## Verification Criteria

- [ ] `cd meridian-llm-go && go build ./...` compiles
- [ ] `cd meridian-llm-go && go test ./... -count=1` passes (note: provider tests will fail because providers still return channels — that's expected and OK)
- [ ] `cd meridian-llm-go && go test -run TestMiddleware -count=1 -race` passes
- [ ] `cd meridian-llm-go && go test -run TestUsage -count=1 -race` passes
- [ ] `cd meridian-llm-go && go vet ./...` passes
- [ ] No proxy goroutines or proxy channels remain in usage_metering.go
