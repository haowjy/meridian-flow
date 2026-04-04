# WebSocket Streaming Migration — Requirements

## Core Architecture Decision

**Two project-scoped WS connections, not one.**

- `/ws/projects/{projectId}/threads` — thread/turn/streaming concerns
- `/ws/projects/{projectId}/docs` — document/proposal/Yjs concerns

Rationale: docs and threads are separate concerns. User wants them separated even though they could share a connection. Each connection uses the same generic protocol.

## Generic Protocol

Both connections use an identical wire protocol with three lanes:

### Control Lane
Connection lifecycle: connect, connected, subscribe, subscribed, unsubscribe, unsubscribed, ping, pong, error.

### Notify Lane (always-on, lightweight)
Server pushes tiny invalidation hints: resource type + ID + event name + optional metadata. Frontend uses these to know WHEN to refetch via REST (TanStack Query invalidation pattern) or when to auto-subscribe to a stream. No full data payloads.

Examples:
- `turn:T1 completed` — frontend invalidates the turn query
- `thread:T3 spawn_started` — frontend may auto-subscribe to the new turn
- `document:D1 updated` — frontend invalidates the document query
- `proposal:P1 created` — frontend invalidates the proposals list

### Stream Lane (opt-in, heavy)
Client explicitly subscribes to a resource for full event data. Supports seq/epoch for replay, gap detection, backpressure. This is where AG-UI events flow (thread WS) or Yjs CRDT sync flows (doc WS).

## Reusability Requirement

The protocol and its Go implementation (`wsutil` package) must be fully generic — not tied to threads or documents. Creating a third WS connection type (e.g., for work items, presence) should be plugging in new resource handlers, not copying infrastructure.

## What the existing project WS actually does

The current project WS (`collab_project.go`) is a generic notification bus:
- Broadcasts `proposal:new`, `doc:error`
- Handles `heartbeat`
- The inbound command path (`proposal:accept/reject/requestUpdate`) is dead code — never handled server-side

This behavior becomes the notify lane of the new doc WS. The existing document WS (per-document Yjs binary sync) stays as-is for now, but could eventually become the stream lane of the doc WS.

## Constraints

- No SSE fallback. WebSocket only.
- No v1 backward compatibility needed.
- Strip all references to SSE, channel-less compat, `project:connected` legacy format.
- Server restart = non-resumable. Gap → REST fallback. Don't try to be clever about crash recovery.
- Observability deferred. Structured logging with turn/connection IDs is sufficient for now. No metrics/dashboards needed until real users exist.

## Success Criteria

1. Generic `wsutil` protocol package that both thread WS and doc WS instantiate
2. Thread WS replaces SSE for streaming with full AG-UI event delivery
3. Interjection drain race fixed in service layer (not transport)
4. Doc WS replaces current project WS notification behavior
5. Frontend uses notify lane for cache invalidation, stream lane for active viewing
6. Existing document Yjs WS unchanged
