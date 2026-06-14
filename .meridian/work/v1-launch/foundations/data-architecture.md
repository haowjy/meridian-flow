# Data Architecture

## Core Principle

**Optimistic universal flow:** update state (triggers render) → fire Dexie write + POST concurrently → reconcile. Never wait for the server before showing the user's action.

The existing doc editor already works this way. Threads need to be fixed to match.

## Data Ownership

| Data | Authority | Cache | Notes |
|------|-----------|-------|-------|
| Documents | Local-first (IndexedDB + y-indexeddb) | Dexie + y-indexeddb | Server syncs in background |
| Threads/Messages | Server-authoritative | IndexedDB as cache only | Required for billing/credit safety |
| Project tree | Server-authoritative | Dexie (bulk cache) | Offline tree ops queued |
| UI state | Local (localStorage) | Zustand persist | Small data, synchronous |

## Why Threads Are NOT Local-First

- Credit checks and turn creation happen server-side
- Local-first threads create ghost turns and duplicate-billing risk
- Existing frontend already keeps threads network-first — v1 design should not regress

## Transport Architecture

### Documents: WebSocket + LRU
- Y.Doc sync over persistent WebSocket
- LRU evicts **full document session** (Y.Doc + CM6 + WebSocket), not just CM6
- Reconnect on navigate-back

### Threads: HTTP/SSE
- User sends via POST (optimistic render immediately)
- AI responds via SSE stream
- No persistent connection between messages
- LRU caches in-memory state (messages, scroll, CM6 input)
- Evicted threads reload from IndexedDB cache

### AI Document Edits: Single Ordering Boundary
- During streaming, AI edits go through **one authoritative Yjs update path** regardless of transport
- WebSocket if doc is connected (LRU cached), HTTPS if evicted
- Backend applies edit server-side either way
- No dual-apply races

## IndexedDB Split

| Layer | Owns | Purpose |
|-------|------|---------|
| Dexie.js | App cache, queues, thread state, pending ops, proposal cache | Application-layer persistence |
| y-indexeddb | Collaborative document bodies (Y.Doc binary state) | CRDT persistence |

Two IndexedDB databases, documented ownership. Don't mix.

## Carry-Forward from Existing Frontend

The sync system already exists and works — five transport-specific subsystems:
- HTTP drains (IndexedDB-backed, survive reload): document save, tree queue
- WebSocket (session-scoped): Yjs doc sync, pending rejects
- Local cache (IndexedDB, fire-and-forget): proposal yjsUpdate cache

Port the architecture. Fix optimistic patterns in threads.
