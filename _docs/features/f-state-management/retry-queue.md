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
- Max 5 retry attempts
- 5-second retry interval
- 4xx errors → show toast, don't retry
- 5xx errors → auto-retry

---

## Retry Intervals

5s, 10s, 20s, 40s, 80s (with jitter)

---

## Dev Tools

**Retry Panel**: Shows queue state, manual retry trigger

**Toggle**: `VITE_DEV_TOOLS=1`

**File**: `frontend/src/core/components/DevRetryPanel.tsx`

---

## Related

- See [optimistic-updates.md](optimistic-updates.md) for usage
- See `frontend/src/core/lib/sync.ts` for sync processor
