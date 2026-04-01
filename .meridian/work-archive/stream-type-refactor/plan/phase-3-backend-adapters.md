# Phase 3: Backend Adapters

## Scope

Update backend adapter files to consume `*Stream` from the library instead of `<-chan StreamEvent`. The backend domain keeps its own channel-based StreamResponse — only the adapter boundary changes.

## Design Spec

See `.meridian/work/v1-launch/features/middleware/stream-type-final.md` under "Backend Adapter Strategy" and "Backend Executor Adapter".

## Files to Modify

- `backend/internal/service/llm/adapters/anthropic_adapter.go` — Update to consume `*Stream` via `Next()/Event()/Err()` pattern, convert to domain events.
- `backend/internal/service/llm/adapters/openrouter_adapter.go` — Same.
- `backend/internal/service/llm/adapters/lorem_adapter.go` — Same.
- `backend/internal/service/llm/adapters/conversion.go` — If shared conversion utilities need updates.

## Adapter Pattern

The adapter wraps `*Stream` back into a channel for the backend domain (which keeps its own `StreamEvent` type):

```go
libStream, err := a.provider.StreamResponse(ctx, libReq)
if err != nil { return nil, err }

backendEventCh := make(chan domainllm.StreamEvent)
go func() {
    defer close(backendEventCh)
    defer libStream.Close()
    for libStream.Next() {
        backendEventCh <- convertFromLibraryEvent(libStream.Event())
    }
    if err := libStream.Err(); err != nil {
        backendEventCh <- domainllm.StreamEvent{Error: err}
    }
}()
```

This is justified — the backend executor is a terminal consumer that needs select-based multiplexing.

## Important

- Do NOT change `backend/internal/domain/services/llm/provider.go` — the domain interface keeps its own channel-based return type.
- Do NOT change `mstream_adapter.go` or `tool_executor.go` — they consume domain channels, not library streams.
- The adapters are the ONLY boundary that changes.

## Verification Criteria

- [ ] `cd backend && go build ./...` compiles
- [ ] `cd backend && go test ./internal/service/llm/... -count=1` passes
- [ ] `cd backend && go vet ./...` passes
