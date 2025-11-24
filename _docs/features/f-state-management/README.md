---
stack: frontend
status: complete
feature: "State Management"
---

# State Management

**Zustand stores, IndexedDB caching, and optimistic updates.**

## Status: ✅ Complete

---

## Features

**Zustand Stores** - 5 stores (Project, Tree, Chat, UI, Editor)
- See [zustand-stores.md](zustand-stores.md)

**IndexedDB Caching** - Dexie (documents, chats, messages)
- See [indexeddb-caching.md](indexeddb-caching.md)

**Optimistic Updates** - Write to cache immediately, sync to server
- See [optimistic-updates.md](optimistic-updates.md)

**Retry Queue** - In-memory queue with exponential backoff
- See [retry-queue.md](retry-queue.md)

---

## Files

**Stores**: `frontend/src/core/stores/`
**Cache**: `frontend/src/core/lib/{db.ts,cache.ts}`
**Sync**: `frontend/src/core/services/documentSyncService.ts`

---

## Related

- See [../f-document-editor/saving-and-sync.md](../f-document-editor/saving-and-sync.md) for cache strategies
