---
detail: minimal
audience: developer
---
# Phase 1: Yjs Sync + Transport

**Status:** In planning
**Priority:** High
**Purpose:** Replace snapshot PATCH saves with Yjs CRDT sync over WebSocket via Go-only backend.

## In Scope

- JWT-in-first-message WebSocket authentication (no ticket table).
- Yjs document sync via single WebSocket (Go backend using `y-crdt`).
- Single Go service handles HTTP + WS (no Node service).
- Yjs document persistence (binary state to Postgres, derived `content` + `ai_content` updated on every persist).
- Snapshot-first load + Yjs state sync on connect.
- Awareness/presence transport via `y-protocols/awareness` (opaque relay from day one).
- Offline persistence via `y-indexeddb`.
- `DocumentBroadcaster` and `DocumentStore` interfaces for scaling readiness.
- Error contract (`RESET_REQUIRED`, `AUTH_FAILED`).

## Out of Scope

- AI proposal review UI.
- Multi-agent arbitration policies.

## Deliverables

### Go Backend

- Yjs persistence layer using `y-crdt` (`EncodeStateAsUpdate()` / `ApplyUpdate()` to Postgres).
- WebSocket handler with JWT-in-first-message auth.
- Yjs sync protocol handler (~50 lines on top of `y-crdt` primitives).
- Awareness relay (opaque binary blob forwarding between clients).
- `DocumentResolver` interface (thin cross-domain dependency: doc ID lookup + ownership verification).
- `DocumentBroadcaster` interface + in-memory v1 implementation.
- `DocumentStore` interface + Postgres v1 implementation.
- Heartbeat management (30s interval, 5s timeout).
- Periodic snapshot persistence (see `_docs/plans/collab-ai/spec/compaction-retention.md` for full trigger policy: 2s debounce, every N updates, on disconnect, manual trigger).
- Text extraction via `ytext.ToString()` persisted to `documents.content` (writer view) and `documents.ai_content` (= content in Phase 1; no proposals exist yet).

### Frontend

- `@meridian/cm6-collab` package (sync module): Yjs binding (`y-codemirror.next`), sync state, undo manager.
- `y-indexeddb` integration for offline persistence.
- Host app hooks for WS lifecycle, JWT auth, connection state.
- `useCollabStore` for sync state projection (`Connected`, `Syncing`, `Disconnected`).

### Database

- `documents.yjs_state BYTEA` column (sole source of truth).
- `documents.content TEXT` column kept as derived projection (computed from Yjs state on persist).
- `documents.ai_content TEXT` column added **in Phase 1** (initially = `content`; no proposals exist yet). Old `ai_version`/`ai_version_rev` columns are dropped in Phase 3.
- `collab_document_snapshots` table for history/restore points.

## Cursor Readiness (Phase 5 Prep)

The Yjs awareness protocol is part of the sync layer from day one. The Go server relays awareness updates between clients as opaque binary blobs — it doesn't need to understand the cursor data structure.

```go
// In the WS handler, awareness updates are just another binary message type.
// The server relays them without parsing.
case awarenessUpdateMsg:
    broadcaster.Broadcast(docID, msg, senderConn) // relay to all other clients
```

When multi-user ships (Phase 5), cursor rendering is purely frontend work — no server changes needed.

## Dependencies

- Canonical architecture from `_docs/plans/fb-realtime-collab-editing.md`.
- Storage invariants from `_docs/plans/collab-ai/spec/storage-model.md`.
- Transport/error contracts from `_docs/plans/collab-ai/spec/api-events-contract.md`.
- CM6 package boundary contract from `_docs/plans/collab-ai/spec/cm6-library-model.md`.

## Implements Specs

- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/cm6-library-model.md`

## Exit Criteria

- Single-user typing persists across reload (Yjs state round-trips through Postgres).
- WS disconnect + reconnect syncs without data loss.
- Offline edits survive tab close via `y-indexeddb` and sync on reconnect.
- Awareness protocol delivers cursor/selection state (foundational for Phase 5).
- Invalid JWT is rejected (`AUTH_FAILED`), connection closed.
- Host app integration uses `@meridian/cm6-collab` with no app-specific imports inside the package.
- Snapshot written on disconnect, loadable on next open.
- Go `y-crdt` round-trip: create doc in JS Yjs, encode, decode in Go, verify text (binary compatibility).
- `DocumentBroadcaster` interface can be swapped without core logic changes.

## Open Questions

1. **y-crdt awareness protocol completeness** — Need to verify Go library can identify awareness message types for relay. If awareness relay is just "forward opaque bytes," Go only needs to tag message types, not parse them.
2. **y-crdt sync protocol handler** — Primitives exist but message framing/exchange logic (~50 lines) needs to be written on top of them.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/cm6-library-model.md`
