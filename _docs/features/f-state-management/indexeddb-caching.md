---
stack: frontend
status: complete
feature: "IndexedDB Caching"
---

# IndexedDB Caching

**Dexie for persistent caching of documents, chats, and messages.**

## Status: ✅ Complete

---

## Schema

**File**: `frontend/src/core/lib/db.ts`

**Tables**:
- `documents` - Full documents with content (cache-first)
- `chats` - Chat metadata (network-first)
- `messages` - Chat messages (network-first, prepared for windowing)

**Note**: Chat/turn Dexie caching intentionally disabled for MVP (TODO in useChatStore.ts:15-21)

---

## Cache Strategies

**Documents**: Reconcile-Newest (cache-first with server reconciliation)
**Chats**: Network-First
**Projects**: Persist Middleware (localStorage)

**File**: `frontend/src/core/lib/cache.ts`

---

## Related

- See [optimistic-updates.md](optimistic-updates.md) for write flow
- See [../f-document-editor/saving-and-sync.md](../f-document-editor/saving-and-sync.md)
