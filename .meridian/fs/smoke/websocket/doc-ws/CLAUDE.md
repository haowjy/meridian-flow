# Doc WS Smoke Tests

Tests for `/ws/projects/{projectId}/docs` — document/proposal notifications and Yjs CRDT sync via binary frames.

Run these after modifying: `doc_ws_handler.go`, `collab_proposal_broadcaster.go`, frontend `DocStreamClient`, or `DocumentWsProviderImpl`.

See `../CLAUDE.md` for setup and toy client usage.

## Tests

- `notify-invalidation.md` — proposal/document notify events → TanStack Query invalidation
- `yjs-sync.md` — subscribe to document → Yjs binary frames → CRDT sync
- `yjs-multiplexing.md` — multiple documents on one connection
