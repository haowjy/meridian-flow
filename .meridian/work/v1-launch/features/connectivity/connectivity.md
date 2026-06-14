# Connectivity

WebSocket lifecycle management, offline queue, and connection status.

## Scope

- WebSocket connection management (connect, reconnect, backoff)
- Connection status indicator (connected, reconnecting, offline)
- Offline queue for pending operations (document saves, tree ops)
- Queue drain on reconnect (ordered, deduplicated)
- SSE resilience (reconnect with Last-Event-ID for thread streaming)

## Carry Forward

Port existing sync system — five transport-specific subsystems:

- **HTTP drains** (IndexedDB-backed, survive reload):
  - Document save: `documentSyncService.ts` + `persistentSaveDrain.ts`
  - Tree queue: `treeSyncService.ts` + `treeQueueDrain.ts`
- **WebSocket** (session-scoped):
  - Yjs doc sync: Y.Doc + y-indexeddb
  - Pending rejects: in-memory flush on reconnect
- **Local cache** (IndexedDB, fire-and-forget):
  - Proposal yjsUpdate cache for instant re-open

Convention: concurrency guard, init/cleanup API, transient→retry / permanent→drop.

## v1 Additions

- Visible connection status in status bar
- Graceful degradation messaging ("You're offline — changes will sync when reconnected")
- Dev tools: `VITE_DEV_TOOLS=1` for retry inspector (carry forward)

## Dependencies

- Data layer (sync primitives)
- Notifications (connection status toasts)
