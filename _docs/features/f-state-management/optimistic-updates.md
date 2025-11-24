---
stack: frontend
status: complete
feature: "Optimistic Updates"
---

# Optimistic Updates

**Write to cache immediately, sync to server in background.**

## Status: ✅ Complete

---

## Flow

1. User makes change (edit document)
2. Update IndexedDB immediately (optimistic)
3. Update UI (instant feedback)
4. Sync to server in background
5. On success: Done
6. On 409 Conflict: Server wins, update cache
7. On 5xx/network error: Retry automatically

**File**: `frontend/src/core/services/documentSyncService.ts`

---

## Benefits

**Instant UI**: No wait for server response
**Offline-capable**: Can continue working (syncs later)
**Resilient**: Auto-retry on failure

---

## Related

- See [retry-queue.md](retry-queue.md) for retry logic
- See [indexeddb-caching.md](indexeddb-caching.md) for cache
