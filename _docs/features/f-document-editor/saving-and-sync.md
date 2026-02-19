---
stack: frontend
status: complete
feature: "Saving and Sync"
---

# Saving and Sync

**Auto-save, optimistic local writes, and persistent retry for non-collab saves.**

## Status: ✅ Complete

---

## Auto-Save

- Debounce: 1s trailing edge
- Trigger: editor content changes
- Flow:
  1. Save optimistic content to IndexedDB.
  2. Attempt server sync.
  3. On success, apply canonical server timestamps.
  4. On network/5xx (non-collab path), persist save to `pendingDocumentSaves` for retry.
  5. On 4xx, bubble error for manual retry.

## Read/Write Policy

- Read: Reconcile-Newest (`db.documents` warm read, then server reconcile).
- Write: optimistic local update + background sync.
- Conflict: server timestamp is canonical; cache updates on server-newer responses.

## Collab vs Non-Collab

- Collab text docs (`.md`, `.markdown`, `.txt`) use Yjs transport + `y-indexeddb` durability.
- Non-collab paths use REST save + Dexie-backed persistent retry (`pendingDocumentSaves`).

## Key Files

- `frontend/src/features/documents/hooks/useDocumentSync.ts`
- `frontend/src/core/services/documentSyncService.ts`
- `frontend/src/core/lib/persistentSaveDrain.ts`
- `frontend/src/core/lib/cache.ts`
- `frontend/src/core/lib/db.ts`

## Related

- [../f-state-management/retry-queue.md](../f-state-management/retry-queue.md)
- [../f-state-management/indexeddb-caching.md](../f-state-management/indexeddb-caching.md)
