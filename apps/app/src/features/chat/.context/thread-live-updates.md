# Thread live updates

A mounted chat thread stays current when the server advances it. One mounted
subscriber owns the thread's transport subscription and its snapshot, and it
is the chat's one run-state feed. So a thread that moved while the writer was
elsewhere, a server-initiated run that wakes the parent from a background
child's report, or a message another client sent renders without a reload and
streams while the writer watches.

## Snapshot revalidation

`useThreadSnapshotSync` (`../../../client/query/useThreadSnapshotSync.ts`) is the binding of
the chat's `ThreadSync` (`createThreadSync`, `@meridian/thread-client/sync`): it creates, starts
and stops one per mounted chat, and React Query is the fetcher it asks for reads. The rules below
(refresh triggers, gap checks, the join) are the sync's, shared with `./mf`; the hook keeps the
fetch. Every completed read reaches `sync.receive` inside the `queryFn`, so the cache publishes
only reads the sync applied; a `stale` answer throws `StaleThreadSnapshot` and retries after
`SNAPSHOT_RETRY_MS`. It owns
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
  state. When the timer fires, the sync asks for a read only if the record names a
  waiting writer message the transcript lacks (`unheldWriterMessages`) or the
  cell holds a write-mode divider whose anchor turn is missing
  (`missing(synced)`). The stream carries no user turns, so another
  client's waiting message reaches a passive tab only through this snapshot.
  Checking at fire time keeps this device's own acknowledged send from
  refetching.
- Missing turns request authoritative history, never a synthetic streaming
  turn. The store's durable wire cursor and snapshot floor reject replay
  rewinds and old HTTP responses.

- `settled` means the chat's run-state `history` is set, so the snapshot's turns are in the
  transcript store (or the load failed), not merely fetched. The sync applies a read before
  React Query publishes it, so a render never sees the snapshot ahead of its turns; a cell kept
  from an earlier mount is settled at once.

Both this fetch and the transport's gap recovery funnel through
`sync.receive` (`applyRead`). The reconciliation mechanics (identity bridge, monotonic
sequence guard) live in the app-level
[`../../../../.context/CONTEXT.md`](../../../../.context/CONTEXT.md) "Thread
snapshot reconciliation" section.

## Run state and joining a live run

The accepted snapshot, the `subscribed` state and every `meridian.run_state`
frame go into the run-state slice (`packages/thread-client/src/run-state/run-state-slice.ts`, held in the chat's `SyncedThread`)
as whole records; the shared view keeps the newest by version. The admission
answer adds this device's message intent at its `runStateVersion`
(`ThreadRunController`, which follows no run). A `meridian.write_mode.switched`
frame installs the divider in the transcript and answers the switch intent in
the slice; a `meridian.messages.handed_back` frame removes the handed-back
turns at its seq.

There is no per-run resume and no follow controller. The first accepted snapshot
joins the stream from its `resumeAfterSeq`, or the held delivery cursor if newer.
Later snapshots do not rewind the subscription. A first send keeps the subscriber
inactive while the chat is pending creation, then activates it.

Activity and durable-projection subscribers without a cursor start at the server's
current head. `useThreadActivity` replaces activity from the whole live-state
acknowledgment. `useThreadDurableProjections` reads trails and Work binding on mount
and again on each acknowledgment: events between the mount read and head sampling
are omitted from replay. Mount reads also cover joining an already active shared
lease, which produces no new acknowledgment. Existing coalescing handles triggers
during a read; gap reconciliation remains the recovery for missing replay.

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

## Stop and hand-back

Stop (`useChatStop`, pressing the shared hand-back operation through `useHandBack`; the queue's x and Cancel queue press the same one) cancels the running reply and hands every waiting writer
message back into the composer, in send order as one plain editable message with
a blank line between them, above what is typed. The press is written to the tab's
composer draft (`handBacks`) before it is sent, so a reload re-posts it; the
answer's content is prepended by one checked draft write that also records its
`received` receipt, and only then is the command retired. A document that would
not restore after a reload never retires the command. References come back as
chips only when the chat proves their owner (`chatReferenceResolver`): a
`scratch://` URI on this chat's lineage handle, `uploads://@c15/` for this chat's own handle,
`@w3` (the Work's handle) for this chat's own Work, or a project or user reference. Anything else,
another named Work included, comes back as its link text, so no content is lost.
An image takes its type from the message's image block, not the extension.
Send-time chip metadata would make this exact (see the shared client's FUTURE).

`StopStatus` belongs to the tab that pressed Stop; other tabs see the record.
`pending` is the press. An answer naming a cancelled execution reads `stopping`
while the held record still shows it; any other answer clears. `failed` says so
on the Stop control and stays after the chat goes idle and with text in the
composer, so the retry (same request id and body) stays reachable. A compaction
divider's Stop is this one; only a handoff brief's own Stop (`useTurnStop`) uses
the turn cancel route. While a hand-back is in flight `hiddenWriterTurns` keeps
those rows out of the transcript.
