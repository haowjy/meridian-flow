---
stack: frontend
status: complete
feature: "Retry Queue"
---

# Retry Queue

**In-memory retry queue with exponential backoff.**

## Status: ✅ Complete

---

## Implementation

**File**: `frontend/src/core/lib/retry.ts`

**Features**:
- In-memory queue (no persistent queue)
- Exponential backoff with jitter
- Max 3 retry attempts
- 5-second retry interval
- 4xx errors → show toast, don't retry
- 5xx errors → auto-retry

---

## Retry Intervals

5s, 10s, 15s (linear with jitter)

---

## Retry Cancellation

Retries are automatically canceled in these scenarios:

### On Document Delete
Before deleting from IndexedDB/server, cancel pending retries:
- `cancelRetry(id)` - cancels content sync retry
- `cancelAIVersionClearRetry(id)` - cancels AI version clear retry

Prevents stale content from being re-synced after deletion.

### On Document Switch
When switching documents, AI version clear retries for the previous document are canceled.
Prevents clearing AI version on wrong document.

### On New Save
When saving new content, any pending retry for that document is canceled.
Newer content wins.

---

## Dev Tools

**Retry Panel**: Shows queue state, manual retry trigger

**Toggle**: `VITE_DEV_TOOLS=1`

**File**: `frontend/src/core/components/DevRetryPanel.tsx`

---

## Related

- See [optimistic-updates.md](optimistic-updates.md) for usage
- See `frontend/src/core/lib/sync.ts` for sync processor
