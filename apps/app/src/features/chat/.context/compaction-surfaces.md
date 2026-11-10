# Compaction surfaces

What the writer sees of compaction. The data contract is the runtime's
(`packages/contracts/src/threads/README.md`).

## Rows and replies

Response grouping, `continuesResponse` and the delivery walk switch on row kind,
not role: a `compaction` row is looked past, any other non-`turn` row ends a reply,
and the delivery walk stops at the next rendered row. A mid-response autocompaction
therefore keeps one action row and one Info scope across both parts, while delivery
rows don't attach across a divider. A reply never spans the fork point or two
owners.

The empty, complete assistant turn directly before a compaction is the reply a
context overflow completed before recovering; it draws no row.

A divider is a closing turn for the failed-reply rule (`chatMovedPast`): a failed
reply followed by one no longer offers Retry. A queued command isn't a transcript
row and doesn't count. An autocompaction's failed reply comes after its divider, so
it stays current.

## The divider

The client owns no reason-specific failure copy: a manual failure is a card with
the server's generic `turn.error`, or a fallback when that is null. A failed
divider keeps the neutral "Compaction" label; only its card reports failure, so
nothing survives once a replacement is queued. An autocompaction's failure stays
quiet, carried by the failed reply under the newest message. There is no "nothing
to compact" state: a manual `/compact` always compacts.

On a complete divider the icon and state label are one button, named by the full
label plus ", summary", and the section drops its own name, so the state words are
read once. Without a summary, the section's name keeps the full label.

Nothing on a divider reverses the compaction. A complete divider's actions are Fork
and Info, the same `ForkTurnAction` and `TurnInfoButton` a reply uses, with no Copy
or Hand off.

The divider is one line at every width, at the 12px label size (`text-xs`); only the opened summary
reads at chat body size. Its section is a container: below `@lg` the state label
switches to a short form and truncates last.

## Composer during a run

`composerRun(turns)` decides what the composer's Stop acts on: a streaming reply, a
pending compaction divider, or a handoff brief being written (a pending seed with
no lease or phase). Turns carry this rather than the snapshot's status, which can
trail the turn.

## Queued commands

`/compact` always runs as the command and is never sent to the model as a message.
The app doesn't pre-check a chat with no completed reply: the server refuses with
409 `compact_requires_completed_reply` and the refusal shows on the command's row.
Queue order is the server's, and the client special-cases none of it.

`useThreadControls` mints the id and shows the item as queued before the network
answers. A failed enqueue stays on the item with Retry under the same id, because
the server treats a repeat as the original. Queued commands render at the
transcript tail and take no transcript position until they run. A queued row's Stop
cancels the command before it runs; it is not the Stop of a running divider.

Stop on a queued row removes it at once and, once any in-flight enqueue settles,
always calls the server, even for a row whose enqueue looked failed: only the
response may have been lost, and a command the client hid can't be allowed to run
unseen. The server answers `withdrawn`, `already_started` or 404.

- A confirmed answer keeps the id hidden against stale run-state records. On
  `already_started` the row goes and the pending divider carries the state.
- A 404 only drops the local send: the enqueue may still have been committing, so
  if the record lists the id later the row shows again.

A queued row leaves by one rule (`retainControls`): it stays until a transcript
turn carries its control id, because the record drops the item as the command
starts, before its divider reaches the transcript. Otherwise it leaves on proof
that it won't run: this device's Stop, or an accepted snapshot at or after the
record that dropped it, whose turns lack the id. A dropped row asks for that
snapshot.

Rows and dividers carry no live region. `useThreadControls` and
`useControlTurnAnnouncements` announce through the global polite announcer, which
reaches rows the virtualized list has scrolled away.

Compaction turns have no AG-UI stream, and a cancelled one ends without
`RUN_FINISHED`; see [thread live updates](thread-live-updates.md).
