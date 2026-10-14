# Thread live updates

A mounted chat thread stays current when the server advances it. One mounted
subscriber owns the thread's transport subscription and its snapshot, and it
is the chat's one run-state feed. So a thread that moved while the writer was
elsewhere, a server-initiated run that wakes the parent from a background
child's report, or a message another client sent renders without a reload and
streams while the writer watches.

## Snapshot revalidation

`useThreadSnapshotSync` (`../../../client/query/useThreadSnapshotSync.ts`) owns
the authoritative history fetch. Every producer of the snapshot key builds its options with
`threadSnapshotQueryOptions` (`../../../client/query/thread-snapshot-query.ts`); the host adds
the account abort signal and its identity and staleness checks as a guard.

- The query is always stale (`staleTime: 0`) with `refetchOnMount: "always"`, so
  every activation refetches. Cached turns render first and the fetch reconciles
  behind them; navigate-first is preserved.
- **Unconditional refreshes** (debounced 250 ms): `RUN_STARTED`, `RUN_FINISHED`,
  `RUN_ERROR`, `meridian.usage`, `meridian.thread.status` (a handoff brief has
  no lease or run), a gap, and a `meridian.run_state` record whose open
  execution changed. A cancelled autocompaction projects no `RUN_FINISHED`, and
  a divider reserves or settles with its execution, so the execution change is
  when those land.
- **Gap-only refreshes** (same timer): any other record, and the `subscribed`
  state. When the timer fires, the hook refetches only if the record names a
  waiting writer message the transcript lacks (`unheldWriterMessages`) or the
  store holds a write-mode divider whose anchor turn is missing
  (`dividersAwaitingAnchor`). The stream carries no user turns, so another
  client's waiting message reaches a passive tab only through this snapshot.
  Checking at fire time keeps this device's own acknowledged send from
  refetching.
- Missing turns request authoritative history, never a synthetic streaming
  turn. The store's durable wire cursor and snapshot floor reject replay
  rewinds and old HTTP responses.

- `settled` means the snapshot's turns are in the transcript store (or the
  load failed), not merely fetched: the accepted snapshot is visible one commit
  before `applyThreadSnapshot` lands it, and a reader such as the turn reveal
  would take that empty transcript for "no such turn".

Both this fetch and the transport's gap recovery funnel through
`applyThreadSnapshot`. The reconciliation mechanics (identity bridge, monotonic
sequence guard) live in the app-level
[`../../../../.context/CONTEXT.md`](../../../../.context/CONTEXT.md) "Thread
snapshot reconciliation" section.

## Run state and joining a live run

The accepted snapshot, the `subscribed` state and every `meridian.run_state`
frame go into the run-state slice (`../../../client/run-state/run-state-slice.ts`)
as whole records; the shared view keeps the newest by version. The admission
answer adds this device's message intent at its `runStateVersion`
(`ThreadRunController`, which follows no run). A `meridian.write_mode.switched`
frame installs the divider in the transcript and answers the switch intent in
the slice; a `meridian.messages.handed_back` frame removes the handed-back
turns at its seq.

There is no per-run resume and no follow controller. The subscription starts
at mount. The first accepted snapshot that shows work in progress
re-subscribes from that snapshot's `resumeAfterSeq`, so the reply it joins
streams from where the snapshot ends. A later snapshot never rewinds: the live
stream has already applied what it shows. A first send keeps the subscriber
inactive while the chat is pending creation, then activates it.

Do not gate refreshes on a mount-scoped latch, and do not move the snapshot
fetch behind a cache window. Either one breaks live updates for a background
child's report or another client's message.

## Live CUSTOM events

`@meridian/thread-client`'s turn reducer (`src/turns/reduce-turn-event.ts`) reduces AG-UI `CUSTOM` frames by name.
Every name the server's orchestrator event projector emits has an explicit
branch there: apply it to the store (`meridian.messages.handed_back`,
`meridian.write_mode.switched`), leave it to the snapshot sync above
(`meridian.block.upserted`, `meridian.run_state`, `meridian.usage`), or
ignore it (`meridian.agent.spawn`, whose source the spawn card already carries
in its durable props). An unmatched name falls through to an opaque custom
block on the streaming reply and renders "Unknown component". When the server
adds a CUSTOM name, add its branch and a reducer test in the same change.
