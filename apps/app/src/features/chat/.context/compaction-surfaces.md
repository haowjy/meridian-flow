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
longer offers Retry ([failed-reply Retry](failed-reply-retry.md)). A queued
command is not a transcript row and never counts. R3 is untouched: an
autocompaction's failed reply comes after its divider, so it stays current.

## Divider states

Pending ("Compacting", or "Stopping" once Stop is pressed; a waiting
`/compact` is a queued row, never a divider; Stop through the existing cancel
route on C),
complete (summary disclosure; token counts only when the context shrank),
failed, cancelled. A manual failure speaks on the divider with the server's
generic `turn.error`, or "This conversation couldn't be compacted." when it is
null; the client owns no reason-specific copy (A10). There is no "nothing to
compact" state: a manual `/compact` always compacts (A12). An autocompaction's
failure stays quiet (R3): the failed reply under the newest message carries it.

A divider records the compaction and its summary. Nothing on it reverses the
compaction. A compaction is a turn: a complete divider's action is Fork (the
same `ForkTurnAction` and navigate-first fork as a reply; the fork starts from
the compacted history). It has no Copy and no Hand off. Fork reveals on hover
or focus like a reply's actions and stays visible on touch. The writer's
`/compact <instructions>` show verbatim under the line (`metadata.instructions`,
read defensively), in every state.

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

The only command is `/compact`, offered on every chat and always run as the
command, never sent to the model as a message. A chat with no completed reply
yet (its own or inherited) is refused by the server with 409
`compact_requires_completed_reply`; the app does not pre-check, and the refusal
shows on the command's row as the generic "Couldn't queue the compaction." with
Retry. Typing `/compact <instructions>` and sending
runs it with the rest of the draft, trimmed, as `instructions`; choosing it
from the `/` menu runs it with none. Commands wait at the end of the queue: a
running reply adopts queued messages at each tool boundary, and a new run takes
waiting messages first; a command runs only when no message waits, oldest
first, one per run. Stop (the Stop button, or Esc in an empty composer; with a
draft, Esc leaves the run alone) only ends the turn; the same rule picks what
runs next. The client special-cases none of it and just shows the server's
state.

`useThreadControls` is the shell over `compaction/thread-controls.ts`. It mints
the id, shows the item as queued before the network answers, and keeps a
failed enqueue on the item with Retry under the same id (the server treats a
repeat as the original). A queued command is a dashed rule, "Compaction
queued" with Withdraw, and its instructions verbatim under it, at once. Queued
commands render at the transcript tail, after every queued message whatever
order they were sent in, oldest first; they take no transcript position until
they run. Queued rows have no Stop.

The local state is two small pieces: sends the inbox has not listed yet
(dropped once it lists the id, since the server owns it then) and withdrawals.
Withdraw removes the row at once (focus stays in the transcript when it was
the last) and, once any in-flight enqueue settles, always calls the server,
even for a row whose enqueue looked failed: only the response may have been
lost, and a command the client hid must not run unseen. The server answers
`withdrawn`, `already_started` once a divider carries the command's id, or 404
when it never had the command, which counts as withdrawn. On
`already_started` the row still goes and the pending divider carries the
state; the announcer says "This compaction already started." A failed
withdrawal brings the row back with "Couldn't withdraw. Try again." A command
a divider already names (`controlMessageId`) is no longer queued.

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
