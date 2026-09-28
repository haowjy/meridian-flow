# Compaction surfaces

What the writer sees of compaction, and the rules that keep it honest. The data
contract is the runtime's (`packages/contracts/src/threads/README.md`); this
file owns the pixels.

## Transcript rows

`buildTranscriptModel` returns `rows: TranscriptRow[]`, index-aligned with
`visibleTurns`: every row carries its turn, so reveal landing and the virtual
list read both by index. A `role: "compaction"` turn is a `compaction` row, a
handoff seed is a `handoff-seed` row, a spawned child's seed message that
names `from` sources is a `thread-reference` row, and every other visible turn
is a `turn` row. A fork's inherited rows are the same kinds with an
`inherited` marker, never a synthetic anchor row (see
[fork and handoff](fork-and-handoff.md)). `classifyTurn` still calls
compaction plumbing: that is the conversational head's policy, and it does not
change.

Response grouping, `continuesResponse`, and the delivery walk switch on row
kind, never on role: a `compaction` row is looked past, any other non-`turn`
row ends a reply, and the delivery walk stops at the next rendered row. A
reply never spans the fork point or two owners.

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
`would_recompact` there is no Undo. The server owns availability alone: it
reads `null` while any compaction is pending and `would_recompact` after a
refusal at an unchanged trigger, so the divider follows the snapshot with no
client correction. A queued undo stays on its divider
whatever the availability says, and a refused undo's copy stays on the divider
it targeted, in the quiet muted tone of a historical error (it lost nothing).

The divider is one line at every width. Its section is a container: below
`@lg` the state label switches to a short form ("Compacted") and truncates
last; the section's accessible name keeps the full label.

## Composer during a run

`composerRun(turns)` decides what the composer's Stop acts on. A run is active
while its reply streams and while it works on a run-owned placeholder with no
stream: a pending compaction (`compacting`) or a pending brief (`briefing`).
Stop on either goes through `useThreadControls.stop(turnId, target)`, the
same path as the divider's and the brief card's own Stop, so both show
Stopping and announce in their own words. A send meanwhile queues like any
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
`satisfiesControlId`, a U's control, a handoff seed's control) is no longer
queued. A brief whose seed exists is therefore never a queued row: it is
stopped on its card, never withdrawn. A queued brief Retry has no seed yet and
is withdrawn at the tail like any control.

One announcer. Rows and dividers carry no live region; `useThreadControls`
announces each writer-caused change and `useControlTurnAnnouncements` each
turn-driven one (dividers, undo markers, and brief seeds), through the global polite announcer, which reaches rows the
virtualized list has scrolled away. Status words come from
`compaction/control-copy.ts`, so the announcement and the row say the same
thing for each control kind.

Compaction turns have no AG-UI stream, and a cancelled one ends without
`RUN_FINISHED`. The snapshot revalidates on run end and on every inbox frame
(the server sends one after every lease release); see
[thread live updates](thread-live-updates.md).
