# features/change-trail — trail evidence read and Restore policy

Shared read policy for durable trail evidence, plus the command policy for
restoring a retained Before excerpt from the live peer-mark popover. This
directory is a seam, not a UI surface.

## Mental model

Swept elevation is live-session-only marker state. The durable trail retains
the change's Before excerpt and navigation anchor; any eligible live mark may
vend Restore, whether ordinary or swept. Receipt rows are read-only and offer
the same trail-backed Before/After evidence without recovery controls.

Restore eligibility is gated by the durable restore state on the trail change:
a change already `applied` or `settled` is terminal and its verb is disabled.
Recovery is idempotent by `changeId` — replaying Restore on a
settled change is a no-op, and the hook short-circuits a pending repeat.

## Key rules

Trail detail is one cache entry per (thread, trail), shared by receipt rows and
the peer-mark popover, and it never refetches on re-open — settled evidence is
durable. Only three things invalidate it: a Restore command, a bumped shell
version, and losing access to a document in the trail. A surface that fetches
per open renders its evidence-dependent verbs late; gate the verbs on resolved
evidence and prefetch while the mark is on screen.

`useTrailRestore` holds the command through to trail-detail query
invalidation (`idle → pending → settling → failed`) and dismisses the session
mark only on a successful `applied` / `already_applied` outcome; a failed action
stays `failed` with a retry affordance, never silently applied. The server's
re-read of the trail detail is the terminal signal — consumers must not infer
command completion from busy/idle render edges, the same discipline as the
draft-review React-Query-held settlement in `features/chat`.

## Entry points

| File | What it does |
|---|---|
| `trail-change-recovery.ts` | `trailChangeRecovery(chg)` Restore eligibility; `useTrailRestore` React hook command state |
| `trail-detail-query.ts` | `changeTrailDetailQuery(threadId, trailId)` shared read options; `usePrefetchTrailDetails` warms on-screen marks |

Backed by `@/client/change-trails.ts`: `restoreTrailChange` (server
Restore mutation), `changeTrailDetailKey` (the shared detail query key),
`bodyFromTrailHashline` (decode the display body carried by trail hashline
serialization).

→ [features/chat](../chat/AGENTS.md) — receipts render trail excerpts through
  the shared read policy, without importing the command policy.
→ [features/editor](../editor/.context/CONTEXT.md) — `PeerMarkPopover.tsx`
  reuses the same recovery surface for an anchored session mark.
