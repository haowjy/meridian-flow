# Compaction surfaces

What the writer sees of compaction, and the rules that keep it honest. The data
contract is the runtime's (`packages/contracts/src/threads/README.md`); this
file owns the pixels.

## Transcript rows

`buildTranscriptModel` returns `rows: TranscriptRow[]`, index-aligned with
`visibleTurns`. A `role: "compaction"` turn is a `compaction` row; every other
visible turn is a `turn` row. `classifyTurn` still calls compaction plumbing:
that is the conversational head's policy, and it does not change. Future row
kinds (the handoff brief card, an inherited-source marker) extend the union.

Never rows:

- **Undo markers.** A `system` turn with `metadata.kind: "compaction_undo"`
  folds into the divider it names (`collectUndoMarkers`): a complete U marks it
  undone, the latest errored U is a refusal shown on it.
- **R4 overflow shells.** An empty, complete assistant turn directly before a
  compaction is the reply a context overflow completed before recovering.

A divider does not end a reply. `continuesResponse` and response grouping look
past compaction rows, so a mid-response autocompaction keeps one action row and
one Info scope across A, C, B. Delivery rows never attach across a divider.

## `endsTranscript`

A divider **is** a row for the failed-reply rule: a failed reply followed by a
divider is history, because the writer (or the run) moved on. The
queued-controls tail is not a row and never counts. R3 is untouched: an
autocompaction's failed reply comes after its divider, so it stays current.

## Divider states

Pending (the lease phase, Stop through the existing cancel route on C),
complete (summary disclosure; token counts only when the context shrank),
failed, cancelled, undone. A manual failure says why on the divider, with
`turn.error` as copy except `context_too_large`, whose server copy blames the
writer's message; the client owns that sentence. An autocompaction's failure
stays quiet (R3): the failed reply under the newest message carries it.

Undo is offered only where it is likely to succeed (R-C6-2): on the divider
`snapshot.compactionUndo` names with `availability: "likely"`. With
`would_recompact` there is no Undo. While any compaction runs, no divider
offers Undo (`currentUndoAvailability`): the snapshot still names the divider
the running compaction will replace. A queued undo stays on its divider
whatever the availability says, and a refused undo's copy stays on the divider
it targeted, in the quiet muted tone of a historical error (it lost nothing).

The divider is one line at every width. Its section is a container: below
`@lg` the state label switches to a short form ("Compacted") and truncates
last; the section's accessible name keeps the full label.

## Composer during a run

`composerRun(turns)` decides what the composer's Stop acts on. A run is active
while its reply streams and while it works on a run-owned placeholder with no
stream: a pending compaction (`compacting`) or a pending brief (`briefing`).
Stop on a compaction goes through `useThreadControls.stop` (the divider shows
Stopping); a brief cancels its bound turn. A send meanwhile queues like any
send during a run. Turns, not the snapshot's phase, carry this: the phase can
trail the run's end.

## Writer controls

`useThreadControls` is the shell over `compaction/thread-controls.ts`. It mints
the id, shows the item as queued before the network answers, and keeps a
failed enqueue on the item with Retry under the same id (the server treats a
repeat as the original). A withdrawal's outcome (`withdrawn`, `stopping`,
`already_finished`) lands on the item and stays until the transcript's leaf
moves. Placement: `compaction_undo` on its divider, everything else at the
tail. A control a transcript turn already names (`controlMessageId`,
`satisfiesControlId`, a U's control) is no longer queued.

Compaction turns have no AG-UI stream. The snapshot revalidates on run end and
on inbox frames that carry or clear a control; see
[thread live updates](thread-live-updates.md).
