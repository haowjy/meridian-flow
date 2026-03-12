---
detail: comprehensive
audience: developer, architect
---

# Yjs State Lifecycle

How the backend manages Yjs document state: in-memory sessions, persistence, offline apply, and snapshots.

## Overview

```mermaid
flowchart LR
    subgraph "In-Memory (active sessions)"
        SM["DocumentSessionManager"]
        DS["DocumentSession<br/>Y.Doc + refCount"]
    end

    subgraph "Persistence (Postgres)"
        YS["yjs_state (BYTEA)"]
        CT["content (TEXT)"]
        AC["ai_content (TEXT)"]
        SN["collab_document_snapshots"]
    end

    SM --> DS
    DS -->|"debounce 2s"| YS
    DS -->|"every 500 updates"| SN
    DS -->|"last WS disconnects"| SN
```

---

## Session Lifecycle

### Acquire (ref-count + singleflight)

```mermaid
flowchart TD
    A["Acquire(docID)"] --> B{"Session in map?"}
    B -->|yes| C["refCount++<br/>return session"]
    B -->|no| D["singleflight.Do(docID)"]
    D --> E["loadState(ctx, docID)"]
    E --> F{"yjs_state exists?"}
    F -->|yes| G["Apply to Y.Doc"]
    F -->|no| H["Bootstrap from markdown<br/>Persist bootstrapped state"]
    G --> I["Re-lock, double-check map"]
    H --> I
    I -->|"another goroutine won"| C
    I -->|"still empty"| J["Insert session, refCount=1"]
```

Key design decisions:

- **Singleflight** deduplicates concurrent first-loads. 5 WS connections racing on the same doc trigger one DB read, not five.
- **Detached context** (`context.Background()` + 30s timeout) keeps the shared load alive even if the triggering request is canceled.
- **Post-load double-check** handles the race where another goroutine's singleflight result was already inserted.

See `service/collab/session_manager.go:80-128`.

### Release

```mermaid
flowchart TD
    A["Release(docID)"] --> B["refCount--"]
    B --> C{"refCount == 0?"}
    C -->|no| D["Return"]
    C -->|yes| E["Delete from map"]
    E --> F["flushOnDisconnect"]
    F --> G{"dirty?"}
    G -->|yes| H["Persist state + snapshot"]
    G -->|no| D
```

The map deletion happens **before** the flush. New `Acquire` calls during the flush create a fresh session via singleflight rather than getting a session being torn down.

See `service/collab/session_manager.go:131-161`.

---

## Persistence Model

### Three Triggers

| Trigger | When | Snapshot? | Context |
|---------|------|-----------|---------|
| Debounce timer | 2s after last update | No | `context.Background()` |
| Snapshot interval | Every 500 updates | Yes | Request context |
| Last WS disconnect | `flushOnDisconnect` | Yes | Fresh 10s timeout |

### Debounce + Snapshot Interval

`markDirtyLocked()` is called on every update (human edit or AI accept):

```mermaid
flowchart TD
    A["markDirtyLocked()"] --> B["dirty = true<br/>updateCount++"]
    B --> C{"updateCount >= 500?"}
    C -->|yes| D["persistLocked(snapshot=true)<br/>Reset updateCount"]
    C -->|no| E{"Timer running?"}
    E -->|yes| F["Reset timer to 2s"]
    E -->|no| G["Start 2s timer"]
    F --> H["Timer fires: persistLocked(snapshot=false)"]
    G --> H
```

This means rapid typing delays persistence until 2s of silence, but continuous editing still snapshots every 500 updates.

See `service/collab/session_manager.go:432-450`.

### What Gets Persisted

`SaveState` writes three columns atomically:

| Column | Type | Content |
|--------|------|---------|
| `yjs_state` | BYTEA | Full Yjs binary state |
| `content` | TEXT | Plaintext from Y.Doc (human-visible) |
| `ai_content` | TEXT | Projected text (base + pending proposals) |

See `repository/postgres/collab/document_store.go:100-124`.

### Snapshots

Stored in `collab_document_snapshots` with:
- `snapshot_type`: `"auto_human"` or `"auto_ai_accept"` (based on `lastOrigin` of most recent update)
- TTL-cleaned via `DeleteExpiredAutoSnapshots`

See `repository/postgres/collab/document_store.go:238-251`.

---

## Offline Apply

When `ApplyUpdate` is called with no active WS session (e.g., AI auto-accept while editor is closed):

```mermaid
sequenceDiagram
    participant PS as ProposalService
    participant SM as SessionManager
    participant DB as Postgres

    PS->>SM: ApplyUpdate(docID, yjsUpdate)
    SM->>SM: Check sessions map -- no active session
    SM->>DB: LoadState(docID) -> yjs_state bytes
    SM->>SM: Create temp Y.Doc
    SM->>SM: Apply persisted state + new update
    SM->>SM: Encode merged state + extract text
    SM->>DB: SaveState(state, content, ai_content)
    Note over SM: Temp Y.Doc is discarded (not cached)
```

The temp doc is never stored in the sessions map -- it exists only for the merge operation.

See `service/collab/session_manager.go:221-254`.

---

## Bootstrap: First Collab Session

Documents created via REST API have `content` text but no `yjs_state`. On first `Acquire` or `BuildProjectedState`:

1. Load `content` from documents table
2. Create fresh Y.Doc, insert content into `"content"` Y.Text
3. Persist bootstrapped `yjs_state` back to DB
4. All subsequent operations use the Yjs state (CRDT ancestry established)

See `service/collab/session_manager.go:377-408`.

---

## GetStateSnapshot vs GetCurrentState

| Method | Returns when no active session | Used by |
|--------|-------------------------------|---------|
| `GetStateSnapshot` | `(nil, found=false, nil)` | AIContentProjector (has its own fallback + bootstrap) |
| `GetCurrentState` | Falls back to `stateStore.LoadState()` | GroupAccept (needs bytes, period) |

The split exists because consumers have different fallback needs. AIContentProjector needs the three-value return to trigger bootstrap. GroupAccept just needs the bytes.

See `service/collab/session_manager.go:258-301`.

---

## Related

- [ai-edit-flow](ai-edit-flow.md) -- End-to-end AI edit flow (uses session manager for apply)
- [ai-content-projection](ai-content-projection.md) -- How ai_content is computed from sessions
- [sync-system](../frontend/architecture/sync-system.md) -- Frontend transport layer
