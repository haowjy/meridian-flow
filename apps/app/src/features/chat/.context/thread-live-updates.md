# Thread live updates

A mounted chat thread stays current when the server advances it. Its snapshot
revalidates on activation and when a new run starts, and the handoff attaches a
controller to each distinct active run once. So a thread that moved while the
writer was elsewhere — or a server-initiated run that wakes the parent from a
background child's report — renders without a reload and streams while the
writer watches.

## Snapshot revalidation

`useThreadSnapshotSync` (`../../../client/query/useThreadSnapshotSync.ts`) owns
the authoritative history fetch:

- The query is always stale (`staleTime: 0`) with `refetchOnMount: "always"`, so
  every activation refetches. Cached turns render first and the fetch reconciles
  behind them; navigate-first is preserved.
- The hook subscribes to the thread transport and refetches (debounced 250 ms)
  on `RUN_STARTED` and on gap. A server-initiated run has no local submit to
  learn it from, so this subscription is what surfaces its turn and card.

Both this fetch and the transport's gap recovery funnel through
`applyThreadSnapshot`. The reconciliation mechanics — identity bridge, monotonic
sequence guard — live in the app-level
[`../../../../.context/CONTEXT.md`](../../../../.context/CONTEXT.md) "Thread
snapshot reconciliation" section.

## Per-run resume

`useThreadHandoff` (`../useThreadHandoff.ts`) reads the snapshot's `liveState`
and attaches the controller that applies the run's AG-UI deltas:

- The guard latches **per active run** (`resumedRunRef`, keyed by
  `runningTurnId`/`resumeAfterSeq`), never on an idle snapshot. An idle latch
  would consume the one-shot and leave a later run with no delta subscriber —
  the continuation then renders as an empty live row until a reload.
- The run the mount already started (a Home-origin or in-thread send) is
  recorded as owned rather than hard-blocking every future run, so a later
  server-initiated run still resumes.
- Each distinct run resumes exactly once; a repeat snapshot of the same run is a
  no-op.

Do not reintroduce a mount-scoped boolean that blocks after the first run, and
do not move the snapshot fetch behind a cache window. Either one breaks live
updates for a background child's report.
