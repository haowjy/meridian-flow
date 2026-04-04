# Phase 6: Doc WS Handler + Service Integration

## Scope

Build the doc WS handler using the wsutil framework, replacing the current project WS (`collab_project.go`). This is the simpler of the two handlers — notify lane only, no stream subscriptions. It validates the wsutil framework with a real endpoint before Thread WS adds complexity.

Includes:
1. `DocNotifyHandler` implementing `wsutil.Handler` (minimal — `OnSubscribe`/`OnUnsubscribe`/`OnMessage` return `ErrNotSupported`)
2. `DocNotifier` interface + implementation wrapping `wsutil.Broadcaster`
3. Service integration: proposal service and collab session manager emit through `DocNotifier`
4. Concrete `Authenticator` implementation for the doc WS server
5. Route registration and endpoint wiring

## What's Out of Scope

- Stream lane support for doc WS (deferred — future Yjs CRDT sync)
- Removing old `collab_project.go` (Phase 10 — keep working until Thread WS is also proven)
- Thread WS handler (Phase 7)
- Frontend DocWsProvider (Phase 8)

## Prerequisites

- **Phase 5** (wsutil framework exists)
- **Phase 3** (Auth consolidation — soft dependency; the concrete authenticator benefits from `authenticateToken()` but can work without it)

## Files to Create

### `backend/internal/handler/doc_ws_handler.go`

```go
type DocNotifyHandler struct {
    logger *slog.Logger
}

type docNotifyState struct {
    session wsutil.Session
}

func (h *DocNotifyHandler) OnConnect(session wsutil.Session) (wsutil.State, error) {
    return &docNotifyState{session: session}, nil
}
func (h *DocNotifyHandler) OnSubscribe(state wsutil.State, sub wsutil.SubscribeRequest) error {
    return wsutil.ErrNotSupported
}
func (h *DocNotifyHandler) OnUnsubscribe(state wsutil.State, subId string) error {
    return wsutil.ErrNotSupported
}
func (h *DocNotifyHandler) OnMessage(state wsutil.State, msg wsutil.Envelope) error {
    return wsutil.ErrNotSupported
}
func (h *DocNotifyHandler) OnDisconnect(state wsutil.State) {}
```

### `backend/internal/handler/doc_notifier.go`

`DocNotifier` interface + implementation wrapping `wsutil.Broadcaster`:

```go
type DocNotifier interface {
    NotifyProposal(projectID string, proposalID string, event string, documentID string)
    NotifyDocument(projectID string, documentID string, event string)
    NotifyDocumentError(projectID string, documentID string, code string, message string)
}

type docNotifierImpl struct {
    broadcaster wsutil.Broadcaster
}
```

Each method constructs a structured `wsutil.Envelope` with `kind=notify, op=invalidate` and appropriate resource/payload, then calls `broadcaster.BroadcastNotify(projectID, envelope)`.

### Concrete Authenticator

Implements `wsutil.Authenticator` by calling `authenticateToken()` (from Phase 3) + `authorizer.CanAccessProject()`. If Phase 3 isn't done yet, inline the JWT verification flow.

## Files to Modify

| File | Change |
|------|--------|
| `backend/internal/handler/collab_proposal_broadcaster.go` | Replace `ProjectBroadcaster.BroadcastToProject()` calls with `DocNotifier.NotifyProposal()`. The current broadcaster sends raw JSON bytes; the new one sends structured envelopes. |
| `backend/internal/app/domains/collab.go` | Add doc WS route: `mux.HandleFunc("GET /ws/projects/{projectId}/docs", docServer.Serve)`. Wire `docServer` with wsutil.NewServer + DocNotifyHandler. |
| Service code emitting doc notifications | Any service code that calls `ProjectBroadcaster.BroadcastToProject()` for doc/proposal events → call `DocNotifier` instead. Identify all callers of the current `ProjectBroadcaster`. |

## Notify Events

| Event | Resource | Payload | Triggered by |
|-------|----------|---------|-------------|
| `created` | `proposal` | `{ "event": "created", "documentId": "..." }` | Proposal service on new proposal |
| `accepted` | `proposal` | `{ "event": "accepted", "documentId": "..." }` | Proposal service on accept |
| `rejected` | `proposal` | `{ "event": "rejected", "documentId": "..." }` | Proposal service on reject |
| `updated` | `document` | `{ "event": "updated" }` | Document content change |
| `error` | `document` | `{ "event": "error", "code": "...", "message": "..." }` | Document error |

## Migration Path

The old project WS (`collab_project.go`) continues to work alongside the new doc WS during the transition. The old endpoint sends `{ "type": "project:connected" }` and `{ "type": "doc:error", ... }`. The new endpoint sends the generic protocol envelope format. Both coexist until Phase 10 removes the old one.

**Key difference**: The old `ProjectConnectionRegistry` + `ProjectBroadcaster` interfaces are NOT deleted yet. Instead, the doc WS adds a parallel notification path. Service code that currently calls `ProjectBroadcaster` gets updated to ALSO call `DocNotifier`. In Phase 10, the old path is removed.

Alternative: if the service code already has a clean injection point, replace `ProjectBroadcaster` with `DocNotifier` directly and keep the old WS endpoint disconnected from notifications. This is cleaner if feasible.

## Patterns to Follow

- Existing `collab_project.go` for the general WS handler pattern (but using wsutil instead of raw `x/net/websocket`)
- `collab_proposal_broadcaster.go` for how notifications are currently emitted

## Verification Criteria

- [ ] `go build ./backend/...` passes
- [ ] New endpoint reachable: `GET /ws/projects/{projectId}/docs` accepts WS upgrade
- [ ] Auth flow: send JWT as first message → receive `{ kind: "control", op: "connected", payload: { connectionId: "..." } }`
- [ ] Invalid auth: receive error envelope + connection close within 5s
- [ ] Heartbeat: server sends `ping`, client responds `pong`, connection stays alive
- [ ] Subscribe attempt → receives error envelope (not supported)
- [ ] Proposal notification: create a proposal via API → doc WS receives `{ kind: "notify", op: "invalidate", resource: { type: "proposal", id: "..." }, payload: { event: "created", documentId: "..." } }`
- [ ] Multiple connections for same project all receive the notify event
- [ ] `go test ./backend/internal/handler/...` passes
- [ ] `go vet ./backend/...` passes

## Agent Staffing

- **Implementer**: `coder` (default codex — minimal handler, mostly wiring)
- **Reviewers**: 1x design alignment review (focus: conformance with [doc-ws.md](../design/doc-ws.md), envelope format matches protocol spec)
- **Testing**: `smoke-tester` (verify the WS endpoint works end-to-end with a real connection)
- **Verification**: `verifier`
