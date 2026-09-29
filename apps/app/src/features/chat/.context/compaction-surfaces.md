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

Never a row: an **R4 overflow shell**, the empty, complete assistant turn
directly before a compaction, which is the reply a context overflow completed
before recovering.

A divider does not end a reply. `continuesResponse` and response grouping look
past compaction rows, so a mid-response autocompaction keeps one action row and
one Info scope across A, C, B. Delivery rows never attach across a divider.

## `endsTranscript`

A divider **is** a row for the failed-reply rule: a failed reply followed by a
divider is history, because the writer (or the run) moved on, and it no
longer offers Retry ([failed-reply Retry](failed-reply-retry.md)). The
queued-commands tail is not a row and never counts. R3 is untouched: an
autocompaction's failed reply comes after its divider, so it stays current.

## Divider states

Pending (the lease phase, Stop through the existing cancel route on C),
complete (summary disclosure; token counts only when the context shrank),
failed, cancelled. A manual failure says why on the divider, with
`turn.error` as copy except `context_too_large`, whose server copy blames the
writer's message; the client owns that sentence. `nothing_to_compact` is not
an alarm: the divider reads "There is nothing to compact yet" in the muted
tone, with no error copy. It is expected after an automatic compaction took
care of what a queued `/compact` asked for. An autocompaction's failure stays
quiet (R3): the failed reply under the newest message carries it.

A divider records the compaction and its summary. Nothing on it reverses the
compaction.

The divider is one line at every width. Its section is a container: below
`@lg` the state label switches to a short form ("Compacted") and truncates
last; the section's accessible name keeps the full label.

## Composer during a run

`composerRun(turns)` decides what the composer's Stop acts on. Work is active
while a reply streams and while a placeholder with no stream is pending: a
compaction divider, or a handoff brief being written (a pending seed, with no
lease or phase). Stop on a divider goes through `useThreadControls.stop`, and
on a seed through `useHandoffBrief.stop`; both share `useTurnStop`, the same
path as the divider's and the card's own Stop, so each shows Stopping and
announces in its own words. A send meanwhile queues like any send during a
run. Turns, not the snapshot's status, carry this: the status can trail the
turn.

## Writer commands

The only command is `/compact`. It runs only when replies
finish: at the end of the queue, one per run. Stop (the Stop button, or Esc in
an empty composer; with a draft, Esc leaves the run alone) runs a queued
command at once, before the waiting messages, which are answered after it; the
client just shows the server's state (the reply stops, "Compacting" appears).

`useThreadControls` is the shell over `compaction/thread-controls.ts`. It mints
the id, shows the item as queued before the network answers, and keeps a
failed enqueue on the item with Retry under the same id (the server treats a
repeat as the original). A queued command waits at the tail as a dashed rule:
"Compaction queued. Runs when replies finish." with Withdraw. Messages sent after it render above it; it
stays last until it runs. Queued rows have no Stop.

Withdraw removes the row at once (focus stays in the transcript when it was
the last). The server answers `withdrawn`, or `already_started` once a divider
carries the command's id: then the row says "This compaction already started."
until the divider that names it arrives (or the leaf moves). A
failed withdrawal brings the row back with "Couldn't withdraw. Try again."
Withdrawing a command whose enqueue then failed finishes locally with no
request, and a 404 on an id the inbox never listed counts as withdrawn: in
both the server never took the command. A
command a divider already names (`controlMessageId`) is no longer queued.

One announcer. Rows and dividers carry no live region; `useThreadControls`
announces each writer-caused change and `useControlTurnAnnouncements` each
turn-driven one (dividers and brief seeds), through the global
polite announcer, which reaches rows the virtualized list has scrolled away.
Status words come from `compaction/control-copy.ts`, so the announcement and
the row say the same thing.

Compaction turns have no AG-UI stream, and a cancelled one ends without
`RUN_FINISHED`. The snapshot revalidates on run end and on every inbox frame
(the server sends one after every lease release); see
[thread live updates](thread-live-updates.md).
