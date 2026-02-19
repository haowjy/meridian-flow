---
stack: frontend
status: complete
feature: "Retry Queue"
---

# Retry Queue

**Dexie-backed retry queues with startup/reconnect drain.**

## Status: ✅ Complete

---

## Queues

| Queue | Table | Semantics | Primary Runtime |
|---|---|---|---|
| Document saves | `pendingDocumentSaves` | Last-write-wins by `documentId` | `documentSyncService.ts` + `persistentSaveDrain.ts` |
| Tree mutations | `pendingTreeOps` | FIFO replay (`++id`) + per-entity coalescing | `useTreeStore.ts` + `treeQueueDrain.ts` |

`RetryScheduler` in `retry.ts` is still available for non-persistent retry use cases, but offline-first document/tree durability is handled by Dexie queues.

## Drain Triggers

- Initial app startup
- Browser `online` event
- Periodic safety tick

## Error Handling

| Case | Behavior |
|---|---|
| Network / 5xx | Keep queued; retry next drain cycle |
| 404 tree op | Drop op and continue |
| 409 tree op | Drop op, stop drain, refresh tree |
| Other 4xx | Treat as permanent failure and remove |

## Coalescing Rules (Tree)

- Rename -> rename (same entity): keep latest rename.
- Move -> move (same entity): keep latest move.
- Rename/move -> delete (same entity): keep delete only.
- Different entities: preserve relative FIFO order.

## Related

- `frontend/src/core/services/documentSyncService.ts`
- `frontend/src/core/lib/persistentSaveDrain.ts`
- `frontend/src/core/services/treeSyncService.ts`
- `frontend/src/core/lib/treeQueueDrain.ts`
