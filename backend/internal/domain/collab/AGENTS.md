# Collab Domain

Types and interfaces for real-time collaborative editing. Import: `meridian/internal/domain/collab`. Deep dive: `.meridian/fs/backend/collab/`.

## Key Concepts

- **Yjs CRDT**: Documents use Yjs binary updates for conflict-free concurrent editing. State is a Yjs document encoded as `[]byte`.
- **Proposals**: AI-generated edits are wrapped in `Proposal` structs with Yjs updates. Status lifecycle: `pending` -> `accepted`/`rejected`/`stale`/`reverted`/`invalid`.
- **Status mirror**: `StatusMirror` interface propagates proposal status changes to connected clients via SSE. `ReconcileAll` handles bulk reconciliation on reconnect.
- **Compaction**: Background worker merges old update log entries into checkpoints to bound storage growth. Interval: 60s.
- **Bookmarks**: `CreateAITurnBookmark` snapshots document state at AI turn start for undo/revert.
- **Session management**: `DocumentSessionProvider.GetOrCreateSession` returns a `SyncSession` with Yjs sync protocol support (step1 + payload handling).

## Interfaces

| Interface | Purpose | File |
|-----------|---------|------|
| `DocumentSessionProvider` | Get/create Yjs sync sessions | `session.go` |
| `SyncSession` | Yjs sync protocol (step1, payload) | `session.go` |
| `DocumentContentLoader` | Bootstrap document content | `session.go` |
| `DocumentStateStore` | Load/save Yjs state + content | `state.go` |
| `CheckpointStore` | Compaction checkpoints | `state.go` |
| `ProjectedStateBuilder` | Build projected state for a user | `state.go` |
| `DocumentStateManager` | Apply updates, get snapshots, bookmarks | `state_manager.go` |
| `ProposalStore` | Proposal CRUD | `proposal.go` |
| `UpdateLogStore` | Yjs update log entries | `update_log.go` |
| `BookmarkStore` | AI turn bookmarks | `bookmark.go` |
| `DocumentPresenceTracker` | Check if document has active subscribers | `presence.go` |
| `StatusMirror` | Proposal status -> client SSE | `presence.go` |
| `DocumentResolver` | Resolve doc refs for collab | `resolver.go` |
| `AutoapplyResolver` | Effective autoapply setting | `resolver.go` |
| `ProposalService` | Proposal lifecycle operations (create, accept, reject) | `proposal.go` |
| `RestoreService` | Document restore from bookmark | `restore.go` |

## Conventions

- Collab depends on document system only through `DocumentResolver` -- never imports `docsystem` directly.
- Proposal offsets track Yjs document version for conflict detection.
