# Phase 5: wsutil Framework

## Scope

Build the generic WebSocket framework package at `backend/internal/wsutil/`. Three files implementing the [wire protocol](../design/protocol.md) as specified in [framework.md](../design/framework.md). This is the reusable foundation — both Doc WS (Phase 6) and Thread WS (Phase 7) instantiate it.

The framework is fully generic — not tied to any specific resource type.

## What's Out of Scope

- Concrete handlers (Doc WS handler, Thread WS handler)
- Concrete authenticator implementation (wired in handler phases)
- Byte-budget backpressure (deferred — [backlog.md](../backlog.md) [#41](https://github.com/haowjy/meridian/issues/41))
- Per-user connection limits (deferred — [#42](https://github.com/haowjy/meridian/issues/42))
- Pre-auth DoS protection (deferred — [#43](https://github.com/haowjy/meridian/issues/43))
- Handler/StreamHandler ISP split (deferred — [#44](https://github.com/haowjy/meridian/issues/44))

## Prerequisites

None — this is a Round 1 phase. Creates a new package with no dependencies on other migration work.

## Files to Create

### `backend/internal/wsutil/protocol.go`

Envelope types, marshal/unmarshal, validation, message routing.

```go
// Core types
type Envelope struct { Kind, Op string; Resource *Resource; SubId string; Seq int64; Epoch string; Payload json.RawMessage }
type Resource struct { Type, Id string }

// Constants for kind/op values
const KindControl, KindNotify, KindStream, KindError = "control", "notify", "stream", "error"
const OpAuth, OpConnected, OpPing, OpPong = "auth", "connected", "ping", "pong"
const OpSubscribe, OpSubscribed, OpUnsubscribe, OpUnsubscribed = "subscribe", "subscribed", "unsubscribe", "unsubscribed"
const OpEvent, OpEnded, OpGap, OpMessage = "event", "ended", "gap", "message"
const OpInvalidate, OpError = "invalidate", "error"

// Validation
func (e *Envelope) Validate() error  // validates kind is known, op is present
func ParseEnvelope(data []byte) (*Envelope, error)

// Error envelope helpers
func NewErrorEnvelope(code, message string) Envelope
func NewSubErrorEnvelope(subId string, resource *Resource, code, message string) Envelope
```

Error codes: `SUBSCRIBE_FAILED`, `RATE_LIMITED`, `AUTH_FAILED`, `INVALID_MESSAGE`, `NOT_SUPPORTED`.

### `backend/internal/wsutil/auth.go`

JWT bootstrap + heartbeat re-auth.

```go
// Authenticator is implemented by the concrete auth wiring in each handler setup.
type Authenticator interface {
    // Authenticate verifies the JWT token and returns auth context.
    Authenticate(token string) (*AuthResult, error)
    // CheckProjectAccess verifies the user still has access to the project.
    CheckProjectAccess(ctx context.Context, userID, projectID string) error
}

type AuthResult struct {
    UserID    string
    ExpiresAt time.Time
}
```

Auth bootstrap flow (called from `ws.go` during connection setup):
1. Wait up to 5s for first message
2. Parse as envelope, verify `kind=control, op=auth`
3. Extract `payload.token`
4. Call `Authenticator.Authenticate(token)`
5. Call `Authenticator.CheckProjectAccess(ctx, userID, projectID)`
6. Return `AuthResult` or close with error

Heartbeat re-auth:
1. On each heartbeat cycle, check JWT expiry from `AuthResult.ExpiresAt`
2. Call `Authenticator.CheckProjectAccess()` to re-verify project membership
3. On failure → close connection

### `backend/internal/wsutil/ws.go`

Server, connection lifecycle, scheduler, rate limiting.

```go
// Server — one per endpoint
type Server struct { ... }
func NewServer(opts ...Option) *Server
func (s *Server) RegisterHandler(resourceType string, h Handler)
func (s *Server) Serve(w http.ResponseWriter, r *http.Request)  // HTTP handler
// Server implements Broadcaster
func (s *Server) BroadcastNotify(projectID string, msg Envelope)

// Handler — registered per resource type
type Handler interface {
    OnConnect(session Session) (State, error)
    OnSubscribe(state State, sub SubscribeRequest) error
    OnUnsubscribe(state State, subId string) error
    OnMessage(state State, msg Envelope) error
    OnDisconnect(state State)
}
type State interface{}
type SubscribeRequest struct { SubId string; Resource Resource; LastSeq *int64; Epoch *string }

// Session — per-connection egress API
type Session interface {
    Send(msg Envelope) error
    SendToSub(subId string, msg Envelope) error
    EndSub(subId string)
    Notify(msg Envelope) error
    Close(reason string)
    UserID() string
    ProjectID() string
    ConnectionID() string
}

// Broadcaster — project-wide notifications
type Broadcaster interface {
    BroadcastNotify(projectID string, msg Envelope)
}

// Options
func WithAuth(auth Authenticator) Option
func WithHeartbeat(interval, timeout time.Duration) Option
func WithRateLimit(msgsPerSec int) Option
func WithReadLimit(bytes int64) Option
func WithOriginPatterns(patterns ...string) Option

// ErrNotSupported — handlers return this for unsupported operations
var ErrNotSupported = errors.New("operation not supported")
```

**Connection lifecycle** (see [framework.md](../design/framework.md) §Connection Lifecycle):
1. WS upgrade via `coder/websocket` (origin enforcement, read limit)
2. Auth bootstrap (5s deadline)
3. `OnConnect` for all registered handlers
4. Send `connected` envelope
5. Start heartbeat loop + read loop
6. On disconnect: `EndSub` for all active subscriptions, then `OnDisconnect` for all handlers

**Per-subscription send queues** with fair round-robin scheduling:
- Each subscription gets a buffered channel (capacity: 20)
- Notify lane has its own queue (not subject to stream backpressure)
- Write serialization: single goroutine drains all queues via `select`
- Buffer full → gap + `EndSub(subId)` (terminal — see [framework.md](../design/framework.md) §Backpressure)

**Rate limiting**: 30 msg/s per connection. Counter-based (simpler than sliding window). Excess → drop + initial error envelope.

**Panic recovery**: All handler calls wrapped in `recover()`. Panicking handler disabled for that connection; other handlers continue.

**Connection map** (`ProjectConnMap`): `sync.Map` keyed by projectID → `[]*conn`. `BroadcastNotify` snapshots under lock, sends outside lock.

**Frame enforcement**: Text frames only, binary rejected. 64KB read limit. 1KB notify payload max.

## Dependencies

- `github.com/coder/websocket` (already in go.mod for document WS)
- Standard library only otherwise

## Patterns to Follow

- Existing `coder/websocket` usage in `backend/internal/handler/collab_document_handler.go` for upgrade patterns
- Options pattern similar to `mstream/options.go`

## Verification Criteria

- [ ] `go build ./backend/internal/wsutil/...` passes
- [ ] Unit tests for `protocol.go`:
  - Envelope parsing: valid JSON, invalid JSON, missing kind, unknown kind, binary frame rejection
  - Error envelope construction
  - Validation: missing op, valid kind/op combos
- [ ] Unit tests for `ws.go`:
  - Connection lifecycle: upgrade → auth → connected → heartbeat → disconnect
  - Subscribe: limit enforcement (10 max), duplicate subId rejection
  - Backpressure: buffer full → gap + EndSub
  - Rate limiting: excess messages dropped
  - Panic recovery: handler panic doesn't kill connection
  - BroadcastNotify: sends to all connections for project, not to other projects
- [ ] Unit tests for `auth.go`:
  - Auth timeout (5s deadline)
  - Valid auth → connected
  - Invalid auth → error + close
  - Heartbeat re-auth: expired JWT → close; lost project access → close
- [ ] `go vet ./backend/internal/wsutil/...` passes
- [ ] Framework is fully generic — no imports from `handler/`, `service/`, or domain packages

## Agent Staffing

- **Implementer**: `coder` (default codex — blueprint is very specific, 3 reviewers verify the result)
- **Reviewers**: 1x concurrency review (gpt-5.4 — focus: connection map locking, write serialization, backpressure termination), 1x security review (opus — focus: auth timeout, origin enforcement, binary frame rejection, rate limiting), 1x design alignment review (gpt-5.4 — focus: conformance with [framework.md](../design/framework.md) and [protocol.md](../design/protocol.md))
- **Testing**: `unit-tester` (comprehensive tests are critical — this is the foundation everything builds on)
- **Verification**: `verifier`
