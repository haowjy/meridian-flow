---
stack: frontend
status: complete
feature: "IndexedDB Caching"
---

# IndexedDB Caching

**Dexie v5 for persistent cache + offline-first queue storage.**

## Status: ✅ Complete

---

## Schema

**File**: `frontend/src/core/lib/db.ts`

**Tables**:
- `documents` - Full documents with content (cache-first)
- `threads` - Thread metadata (network-first)
- `messages` - Thread messages (network-first, prepared for windowing)
- `projectTrees` - Per-project tree snapshot cache (`projectId`, `folders`, `documents`, `updatedAt`)
- `pendingDocumentSaves` - Persistent last-write-wins document save queue (`documentId`, `content`, `createdAt`)
- `pendingTreeOps` - Persistent ordered tree mutation queue (`++id`, `projectId`, `[projectId+status]`)

**Note**: Thread/turn Dexie caching is intentionally disabled for MVP (`useThreadStore.ts`). Offline-first document/tree flows actively use `projectTrees`, `pendingDocumentSaves`, and `pendingTreeOps`.

---

## Cache Strategies

**Documents**: Reconcile-Newest (cache-first with server reconciliation)
**Threads**: Network-First
**Projects**: Persist Middleware (localStorage)

### Recent hardening

- Document 404s no longer fall back to stale IndexedDB cache (`ReconcileNewestPolicy` only falls back on transient failures).
- Tree refresh now prunes stale per-document cache rows and pending save retries when a doc was deleted on another device.
- Shared retrieval helpers (`frontend/src/core/retrieval/`) now drive background loading and persisted-selection reconciliation for projects/threads/skills/documents.
- Terminal error handling is centralized by operation (`frontend/src/core/retrieval/terminalErrorPolicy.ts`) so 404/403 behavior is explicit per retrieval path.
- Tree snapshots are normalized at every ingress (`loadTree` cache hydration, `loadTree` server hydration, folder-view hydration, and tree-cache persistence), preventing malformed docs (e.g., missing `path`) and stale child entities from re-entering local state.

**File**: `frontend/src/core/lib/cache.ts`

---

## Related

- See [optimistic-updates.md](optimistic-updates.md) for write flow
- See [../f-document-editor/saving-and-sync.md](../f-document-editor/saving-and-sync.md)
