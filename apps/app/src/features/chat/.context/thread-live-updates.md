# Thread live updates

One mounted subscriber owns the thread's transport subscription and snapshot, and it
is the chat's one run-state feed. A thread that moved while the writer was elsewhere,
a run that wakes the parent from a background child's report, or a message another
client sent therefore renders without a reload.

## Snapshot revalidation

`useThreadSnapshotSync` binds `createThreadSync` (`@meridian/thread-client/sync`) to
React Query. Refresh triggers, gap checks and the join are the sync's, shared with
`./mf`. Every completed read reaches `sync.receive` inside the `queryFn`, so the cache
publishes only reads the sync applied. Every producer of the snapshot key builds its
options with `threadSnapshotQueryOptions`.

- **Unconditional refreshes** (debounced 250 ms): run start, finish and error,
  `meridian.usage`, `meridian.thread.status` (a handoff brief has no lease or run), a
  gap, and a `meridian.run_state` record whose open execution changed. A cancelled
  autocompaction projects no `RUN_FINISHED`, and a divider reserves or settles with its
  execution, so the execution change is when those land.
- **Gap-only refreshes** (same timer): any other record, and the `subscribed` state. The
  sync reads only if the record names a waiting writer message the transcript lacks, or
  the cell holds a write-mode divider whose anchor turn is missing. The stream carries
  no user turns, so another client's waiting message reaches a passive tab only through
  this snapshot. Checking at fire time keeps this device's own acknowledged send from
  refetching.
- Missing turns request authoritative history, never a synthetic streaming turn.

Don't gate refreshes on a mount-scoped latch or move the snapshot fetch behind a cache
window: either breaks live updates for a background child's report or another client's
message.

Reconciliation mechanics are in the app-level
[`.context/CONTEXT.md`](../../../../.context/CONTEXT.md).

## Joining a live run

There is no per-run resume. The first accepted snapshot joins the stream from its
`resumeAfterSeq`, or the held delivery cursor if newer, and later snapshots don't rewind
the subscription. A first send keeps the subscriber inactive while the chat is pending
creation.

Activity and durable-projection subscribers without a cursor start at the server's
current head. `useThreadWorkProjections` reads the Work binding on each acknowledgment, because
events between mount and head sampling are omitted from replay, and because a rebind made in
another window or on another device pushes no hint. The read is always fresh (thread list and
Works, no reuse of a cached list), and both land in their caches, so the list is fresh for the
sidebar's own mount refetch (30 s) after it. It converges (patches the snapshot, invalidates
Work-derived keys) only when the row's `workId` differs from the one the snapshot holds. A gap
reads the same way.

## Live CUSTOM events

`reduce-turn-event.ts` reduces AG-UI `CUSTOM` frames by name. An unmatched name falls
through to an opaque custom block on the streaming reply and renders "Unknown
component", so when the server adds a CUSTOM name, add its branch and a reducer test in
the same change.

## Stop and hand-back

The operation is the shared thread-client one
([thread-client context](../../../../../../packages/thread-client/.context/CONTEXT.md));
the server's boundary and adoption facts are in the runtime
[delivery context](../../../../../server/server/domains/runtime/.context/delivery.md).
What only the app holds:

- References come back as chips only when the chat proves their owner
  (`chatReferenceResolver`): a `scratch://` URI on this chat's lineage handle,
  `uploads://` for this chat's own handle, this chat's own Work's handle, or a project or
  user reference. Anything else comes back as its link text, so no content is lost. An
  image takes its type from the message's image block, not the extension.
- `StopStatus` belongs to the tab that pressed Stop. An answer naming a cancelled
  execution reads `stopping` while the held record still shows it. `failed` stays after
  the chat goes idle and with text in the composer, so the retry stays reachable.
- A compaction divider's Stop is this one; only a handoff brief's own Stop uses the turn
  cancel route.
- While a hand-back is in flight, `hiddenWriterTurns` keeps those rows out of the
  transcript.
