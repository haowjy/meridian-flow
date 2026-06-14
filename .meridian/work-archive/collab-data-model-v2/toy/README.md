# Collab v2 Toy Examples

Interactive demonstrations of the v2 collab data model. These are standalone toys for understanding the architecture -- not production code.

## Frontend (`frontend.html`)

Open in a browser (requires internet for Yjs CDN). Demonstrates:

- Canonical Y.Doc with `Y.Text('content')` + `Y.Map('_proposal_status')`
- Proposal creation with captured `yjs_update` bytes
- Ephemeral projection pipeline (clone, apply, diff, GC, destroy)
- Accept/reject as immediate Yjs transactions
- Session undo (Ctrl-Z) via UndoManager over text + status map
- Thread-level undo/reapply via text find-and-replace
- Projection GC (stale proposal detection)
- Backend status mirroring (Y.Map observer)

Each operation logs what it does, matching the spec file it implements.

## Backend (`backend.go`)

```
cd toy && go run backend.go
```

Walks through backend concepts with simulated data structures:

- Append-only update log (replaces overwrite-merge)
- Checkpoint creation and document loading
- Compaction with bookmark materialization
- Status mirroring from `_proposal_status` Y.Map deltas
- Thread-level undo/reapply via text find-replace
- Two-phase GC strategy

## What these do NOT cover

- CM6 rendering (decorations, widgets)
- WebSocket sync transport
- Hunk grouping algorithm
- Multi-user concurrent scenarios
- Real database operations
