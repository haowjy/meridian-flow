# features/change-trail — shared trail evidence reads

Shared read policy for durable trail evidence. This directory is a seam, not a
UI surface.

## Mental model

Swept elevation is live-session-only marker state. The durable trail retains
the change's Before excerpt and navigation anchor. Receipt rows and live
peer-mark popovers read that same Before/After evidence. Trail evidence is
read-only; receipt Undo/Redo is the sole reversal authority for AI changes.

## Key rules

Trail detail is one cache entry per (thread, trail), shared by receipt rows and
the peer-mark popover, and it never refetches on re-open because settled
evidence is durable. A bumped shell version or lost document access invalidates
the cache. Prefetch while a mark is on screen so the disclosure does not fill
in after the writer opens it.

## Entry points

| File | What it does |
|---|---|
| `trail-detail-query.ts` | `changeTrailDetailQuery(threadId, trailId)` shared read options; `usePrefetchTrailDetails` warms on-screen marks |

Backed by `@/client/change-trails.ts`: `changeTrailDetailKey` (the shared
detail query key) and `bodyFromTrailHashline` (decode the display body carried
by trail hashline serialization).

→ [features/chat](../chat/AGENTS.md) — receipts render trail excerpts through
  the shared read policy, without importing the command policy.
→ [features/editor](../editor/.context/CONTEXT.md) — `PeerMarkPopover.tsx`
  reuses the same evidence surface for an anchored session mark.
