# features/change-trail — Shared trail recovery policy

Shared presentation and command policy for durable change-trail recovery
actions (Restore / Delete-again). This directory is a seam, not a UI surface:
its one module is consumed by chat (`ChangeViewRows.tsx`) and the editor
(`PeerMarkPopover.tsx`).

## Mental model

A trail change carries an optional `writerProtection` (sweep or resurrection)
or `swept` body. One recovery action per change, chosen by protection kind:

- **`delete-again`** when the change resurrected text the writer had deleted.
- **`restore`** otherwise (sweep, or any captured body).

Action eligibility is gated by the durable forward-action state on the trail
change: a change already `applied` or `settled` is terminal and its verb is
disabled. Recovery is idempotent by `changeId` — replaying the same action on a
settled change is a no-op, and the hook short-circuits a pending repeat.

## Key rule

`useTrailForwardAction` holds the command through to trail-detail query
invalidation (`idle → pending → settling → failed`) and dismisses the session
mark only on a successful `applied` / `already_applied` outcome; a failed action
stays `failed` with a retry affordance, never silently applied. The server's
re-read of the trail detail is the terminal signal — consumers must not infer
command completion from busy/idle render edges, the same discipline as the
draft-review React-Query-held settlement in `features/chat`.

## Entry points

| File | What it does |
|---|---|
| `trail-change-recovery.ts` | `trailChangeRecovery(chg)` pure eligibility+presentation; `useTrailForwardAction` React hook command state; `trailChangeLabel` |

Backed by `@/client/change-trails.ts`: `applyTrailForwardAction` (server
forward-action mutation), `changeTrailDetailKey` (the shared detail query key),
`bodyFromTrailHashline` (decode the display body carried by trail hashline
serialization).

→ [features/chat](../chat/AGENTS.md) — `ChangeViewRows.tsx` renders these rows
  in the per-turn and shared Changes cards.
→ [features/editor](../editor/.context/CONTEXT.md) — `PeerMarkPopover.tsx`
  reuses the same recovery surface for an anchored session mark.