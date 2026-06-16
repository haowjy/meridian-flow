# Phase 4: mstream Library Fixes

## Scope

Fix 7 bugs in `meridian-stream-go/` that block WS replay. These are listed in [thread-ws.md](../design/thread-ws.md) §mstream Library Fixes Required. The fixes make the mstream library suitable for the atomic subscribe-with-catchup pattern required by the wsutil framework's `OnSubscribe` handler.

## What's Out of Scope

- Any changes to the backend service layer (those files are touched by Phases 1-2)
- wsutil framework code
- WS handler code

## Prerequisites

None — this is a Round 1 phase. Changes are entirely within `meridian-stream-go/`, no overlap with other phases.

## Fixes Required

### C1: Buffer Clears on Completion (Critical)

**Current**: `markCompleted()` calls `ClearBuffer()` immediately. Terminal events lost on reconnect.

**Fix**: Add a grace period before buffer clear. When `markCompleted()` is called:
1. Mark stream as terminal
2. Start a TTL timer (30s default, configurable via option)
3. On TTL expiry, clear the buffer
4. On any new `SubscribeWithCatchup` call during the grace period, reset the TTL

**Files**: `meridian-stream-go/stream.go` — modify `markCompleted()` and add TTL logic

### C1b: `GetSince` Ambiguity

**Current**: Returns nil for both "not found" and "no events after seq". Callers can't distinguish.

**Fix**: Change signature to `GetSince(seq int64) (events []Event, found bool)`. `found=false` means the sequence number was not found in the buffer (expired or invalid). `found=true, events=nil` means seq was found but no events exist after it.

**Files**: `meridian-stream-go/buffer.go` — modify `GetSince` return signature

### H2: Subscribe Before Catchup (Critical)

**Current**: `AddClient()` and `GetCatchupEvents()` are separate calls — race for duplicates between them.

**Fix**: Add atomic `SubscribeWithCatchup(clientID string, lastSeq int64, epoch string) (catchup []Event, liveChan <-chan Event, status StreamStatus, err error)`:
1. Take the stream lock
2. Snapshot buffer events since `lastSeq` (if epoch matches)
3. Register the live channel
4. Release lock
5. Return catchup events + live channel atomically

If epoch mismatch → return error (caller sends gap). If stream terminal → return catchup events + nil channel + terminal status.

**Files**: `meridian-stream-go/stream.go` — add `SubscribeWithCatchup` method

### H3: `AddClient` on Terminal Stream

**Current**: Blocks forever (channel never closed).

**Fix**: If stream is terminal, return error or immediately-closed channel. `SubscribeWithCatchup` handles this: returns `status=Terminal` and `liveChan=nil`.

**Files**: `meridian-stream-go/stream.go` — modify `AddClient` behavior, already handled by H2's `SubscribeWithCatchup`

### H1: Event IDs Always-On

**Current**: Gated behind `enableEventIDs` flag.

**Fix**: Always assign monotonic event IDs (mandatory for seq tracking in WS protocol). Remove the `enableEventIDs` option flag. Every `Emit()` call assigns a monotonic seq.

**Files**: `meridian-stream-go/stream.go` — remove `enableEventIDs` flag; `meridian-stream-go/options.go` — remove `WithEventIDs()` option

### H6: Registry Overwrites Hooks

**Current**: `Register()` overwrites caller-set `onComplete`/`onError`.

**Fix**: Compose hooks instead of overwriting. When registering a stream that already has `onComplete`/`onError` set, wrap the existing callback:

```go
existingOnComplete := stream.onComplete
stream.onComplete = func() {
    existingOnComplete() // caller's hook first
    r.handleComplete()   // registry's cleanup second
}
```

**Files**: `meridian-stream-go/registry.go` — modify `Register()`

### H7: Catchup Errors Discarded

**Current**: `GetCatchupEvents()` silently ignores `catchupFunc` errors.

**Fix**: Propagate errors to caller. If `catchupFunc` fails, `SubscribeWithCatchup` returns the error.

**Files**: `meridian-stream-go/stream.go` or `meridian-stream-go/buffer.go` — propagate error from catchup path

## Files Summary

| File | Changes |
|------|---------|
| `meridian-stream-go/stream.go` | Add `SubscribeWithCatchup()`, modify `markCompleted()` for grace period, always-on event IDs, fix `AddClient` terminal behavior |
| `meridian-stream-go/buffer.go` | Fix `GetSince` return signature: `(events []Event, found bool)` |
| `meridian-stream-go/registry.go` | Compose hooks in `Register()` instead of overwriting |
| `meridian-stream-go/options.go` | Remove `WithEventIDs()` option |
| `meridian-stream-go/interjection.go` | No changes (interjection is handled by InterjectionForwarder now) |
| Backend callers | Update callers of `GetSince` for new return signature; update callers of removed `WithEventIDs()` option |

## Verification Criteria

- [ ] `go test ./meridian-stream-go/...` passes (existing tests updated for new signatures)
- [ ] New tests for `SubscribeWithCatchup`:
  - Fresh subscribe (no lastSeq) → gets full buffer + live channel
  - Catchup subscribe (matching epoch) → gets events since lastSeq + live channel
  - Epoch mismatch → error returned
  - Terminal stream → catchup events + nil channel + terminal status
  - Concurrent subscribe + emit → no duplicate events, no missed events
- [ ] New tests for buffer grace period:
  - Terminal stream: buffer available for 30s after completion
  - Terminal stream: buffer cleared after TTL expires
  - Subscribe during grace period resets TTL
- [ ] `go build ./backend/...` passes (callers updated for signature changes)
- [ ] Event IDs are always set (test that every emitted event has monotonic seq)

## Agent Staffing

- **Implementer**: `coder` (default codex — concurrency reviewers verify atomicity)
- **Reviewers**: 1x concurrency review (gpt-5.4 — focus: `SubscribeWithCatchup` atomicity, lock ordering with buffer grace period), 1x correctness review (opus — focus: `GetSince` ambiguity fix doesn't break callers)
- **Testing**: `unit-tester` for `SubscribeWithCatchup` edge cases
- **Verification**: `verifier`
