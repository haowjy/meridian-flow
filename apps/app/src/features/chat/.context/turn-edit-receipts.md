# Turn edit receipts

This page defines the chat contract for turn-edit records and reversal.

The per-turn receipt is a quiet, default-collapsed record for live and pending draft
document edits, moves and deletes. Its header counts documents and never names one;
document names belong to the expanded rows, which navigate. It reads "Drafted 1
document" while a drafted document still waits, "Applied" or "Discarded" once every
drafted document has had that outcome, and "Drafted 3 documents: 1 applied, 1
discarded, 1 still a draft" when they differ. The heading reads what is true now of this reply's change, not
what was true when the reply ended: the receipt's `drafts` map (each drafted document
still a draft, applied or discarded, from the same capture as the receipt: still a draft
means a change waits in an open draft at this reply's own text, or the writer typed over
it; another reply's change in the same draft does not count, so each reply's card records
what became of that reply's change) is re-read when
this chat's waiting drafts change (`useDraftDock`). A turn that wrote the manuscript
reads "Edited 1 document", or "Changed 1 document" once it moved or deleted one or
wrote both a draft and the manuscript. A drafted row says "Applied" or "Discarded" at
its end; one still waiting needs no word.
Expanding shows one row per edited document and shows no per-change detail: the
card has no Before/After excerpts or word totals. A conversation reveal opened
from an editor peer mark lands on the owning turn.

`AssistantTurn` combines server-owned facts: full turn lineage supplies the count
and the rows, and the durable receipt supplies whole-turn Undo/Redo authority. Both
direct and draft lineage may produce the same receipt. The receipt is a record of
what the reply wrote: it counts every document the reply wrote to, live or draft,
edited or created, as soon as the reply finishes. Apply and Discard never create
or change it, and Undo never erases its turn-owned record. Pending draft lineage
shows the same card before and after Apply; only its words change.

A document the reply created in a draft counts at once, and pending draft rows
name the edited files.

The receipt reads server lineage, never tool results. A binary copy (an upload
such as a PDF, copied at once with no write handle) leaves no journal row, so it
is not counted as an edit and offers no Undo. Undoing a text copy reverses it like any create (a tree entry
plus its initial text; see the collab `reversal.md`), and the receipt shows it as undone.

A document the turn moved, deleted or copied carries its net tree line in lineage,
and its row says so: "Moved ch4 to ch4-old" (the folder, section or owner kept only
when it tells the destination apart: "Scratch for Ascension/notes/ch4"),
"Deleted ch2", or "Copied ch2 to ch2 (copy)" (a create whose document records
`metadata.copiedFrom`; its `from` is that source). A folder copy records its source on the tree receipt node and uses the same copy line. An owner is named by its Work's
name or its chat's title, never its
handle (#914): the project shell supplies `OwnerNames` (`owner-names.tsx`,
`ProjectOwnerNamesProvider`), and outside it a location reads "Scratch". The
row is a record: it keeps its words after Undo, as text rows do. A deleted
document's row is not a door, because its old address may hold another document
now. The parts list's heading says which command leaves them as
they are: "Undo leaves 2 parts as they are" before a press, "Undo left 1 part as
it was" after one.

The single Undo/Redo action calls the turn-scoped reverse endpoint. Receipt state
(`live-active`, `work-active`, reversed, dependent, or expired) decides whether
it is available. When it is not (`view_change`; the server gives no control once every drafted document is
discarded, where a Redo would bring the discarded text back) the card shows no
control and no failure line: "can't reverse" is never read as "went wrong". What
became of each part shows as plain facts after expansion, worded from the typed
causes ("Taken out", "Stayed as you edited it"); a drafted document's apply or
discard is on its row instead. A deleted document's row stays as a record without
being a door.

A reversal command can race the projected receipt and return a semantic
unavailable outcome with HTTP 200. The mutation invalidates the turn query,
expands the receipt, and retains the returned reason while refreshed lineage
withdraws the action. Do not reduce the result to transport success or clear the
local reason merely because the refreshed control becomes `view_change`; both
hide the semantic refusal after a successful HTTP response.

Every refusal is visible, and the receipt's reason line is where it shows.
Skipped parts and refusals are worded in `turn-receipt-copy.ts` from typed
causes (`TurnInverseSkipCause`, the `ancestor_taken` / `folder_missing` /
`superseded` statuses); the card never prints server prose. A move or delete
whose folder path a document blocks names the cause, the whole place and the next
step, and the parts list doesn't repeat what that line already says. A taken leaf
is not a refusal: the inverse lands beside it as a twin, and the card says where from the
committed transition.
Copy covers the whole wire status union through an exhaustive switch that fails
the build when a status is added, and a command that never reached a status at
all — rejected fetch, HTTP error envelope — gets its own retry line naming the
command the writer pressed. A refused command
never leaves the card unchanged.

Undo reverses the turn's remaining edits where they are now: pending in the
Work's document drafts or already applied to live. Draft and live writes remain one atomic
command. The receipt immediately shows Undoing/Redoing while the command runs;
Yjs publishes the edit after durable commit and failures stay on the card.
Inverse eligibility comes from the inverse kernel's identity classification.
The derived applied/pending/discarded disposition chooses a skipped part's copy,
never grants or refuses Redo. The card offers Redo only for what its own Undo took
back, text and tree alike: an undo the model made in the reply is part of what the
reply did, so the card offers Undo for what still stands, never Redo of the model's
undo. The model redoes its own undo with its `redo` tool. Review text Discard is a separate local
edit in the same stable room, not receipt Undo or a generation reset. Terminal
closure retires that draft identity without changing committed live authority.
Dependency and archived-Work guards still apply.

The card is a record, not a draft control panel. Draft Review/Apply/Discard
remain exclusively in the composer-attached `DraftDock` and inline review
surface.

Work mutation rows consume the shared structured receipt contract. The server
supplies operation, identity, before/after facts, and a typed inverse; this
surface maps those facts through the active Lingui catalog. Idempotent receipts
do not claim a change.

## Reveal staging

A reveal target names a thread or a turn — never a partial path.
It is handed down one stage at a time, and the surface holding a stage reports
`landed` or `unavailable` once its own data settles:

| Stage | Owner | Lands | Reports unavailable when |
|---|---|---|---|
| thread | project shell (`useConversationRevealRouting`) | points the current screen's chat surface at the thread | never — a shell cannot fail to aim a surface |
| turn | transcript (`useTurnRevealLanding`) | centers the turn's row, waiting for a parked viewport to be measured | settled history holds no such turn |

A turn target may also name a `toolCallId`, as a Changes row's chat link does.
After the turn lands, the transcript scrolls to that tool's row and flashes it
(`block-reveal-flash`). A row inside a closed process fold is never opened for
the reveal: the fold's header takes the scroll and the flash, and the turn stays
the landing when neither is found. The landing also releases follow so a
transcript that has just mounted does not pin back to the live edge.

An unavailable stage ends the request where its parent left the writer: a
turn that never arrives still leaves them in the thread. Nothing copies the pending request into
component state — display without the lifecycle is what let a request outlive
everything that could complete it. A stage deadline in the controller is only a
backstop for the case no surface can report: a stage whose surface never mounts.

## A reply the run ended early

A stopped reply keeps the words streamed before Stop and ends with one plain line
(`TurnStoppedLine`): "Stopped." and, when calls never ran, "Stopped. Didn't run: create
Scene C." A call the run ended before it settled carries a result code, and its row reads as done, not
failed, titled by what it was going to do (`EndedCallTitle`, for every tool). The code says what
is known. `TOOL_NOT_RUN_CODE` (the server stores it for a document command; `viewAssistantTurn`
gives it to a call whose input never finished streaming) means it never ran: "Didn't run: …".
`TOOL_STOPPED_CODE` (only `viewAssistantTurn` makes it) is a call that was sent and has no result.
A connection call or a script may have run, so the row reads "Stopped: …" and claims nothing more.
`viewAssistantTurn` reads every unanswered call of an `error` or `cancelled` turn one of these
ways. The model's own record of such a call is the request-time stub,
which lists what a connection call sent ([recovery](../../../../../server/server/domains/runtime/.context/recovery.md)).
Edits that landed stay landed and keep their receipt. A crashed reply keeps its failure card
and adds the "Didn't run" line when calls never ran.

The dock's Apply and Discard stay locked while a round runs. A mid-round Discard of a
document the reply created would send the model "File not found"; the lock lifts when the
server settles an agent write to a discarded draft with `returned`
(never-refuse §6).
