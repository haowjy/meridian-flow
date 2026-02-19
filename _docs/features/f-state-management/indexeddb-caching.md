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

**Note**: Thread/turn Dexie caching is intentionally disabled for MVP (`useThreadStore.ts`). The three offline-first tables are v5 schema foundations and are used by follow-up slices.

---

## Cache Strategies

**Documents**: Reconcile-Newest (cache-first with server reconciliation)
**Threads**: Network-First
**Projects**: Persist Middleware (localStorage)

**File**: `frontend/src/core/lib/cache.ts`

---

## Related

- See [optimistic-updates.md](optimistic-updates.md) for write flow
- See [../f-document-editor/saving-and-sync.md](../f-document-editor/saving-and-sync.md)
