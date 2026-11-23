# Turn edit receipts

This page defines the chat contract for turn-edit records and reversal.

The per-turn receipt is a quiet, default-collapsed record for live and pending draft
document edits, moves and deletes. Its header counts documents and never names one;
document names belong to the expanded rows, which navigate. It reads "Drafted 1
document" while a drafted document still waits or the documents ended differently, and
"Applied", "Undone" or "Discarded" once every drafted document had that outcome. The
heading reads what is true now of this reply's change, not what was true when the reply
ended: the receipt's `drafts` map (one word per drafted document, text and tree halves
folded into the less settled one; still a draft means a change waits in an open draft at
this reply's own text, or the writer typed over it, and another reply's change in the same
draft does not count) is re-read when this chat's waiting drafts change (`useDraftDock`)
and when the writer edits an open document (`useRefreshTurnCardsOnEdit`, debounced; only the
cards whose lineage names that document), so the Undo goes within a moment of the text it depends on changing. A turn that wrote the
manuscript reads "Edited 1 document", or "Changed 1 document" once it moved or deleted one
or wrote both a draft and the manuscript. A drafted row says "Applied", "Undone" or
"Discarded" at its end; one still waiting needs no word.
Expanding shows one row per edited document and shows no per-change detail: the
card has no Before/After excerpts or word totals. A conversation reveal opened
from an editor peer mark lands on the owning turn.

`AssistantTurn` combines server-owned facts: full turn lineage supplies the count
and the rows, and the durable receipt supplies whole-turn Undo authority. Both
direct and draft lineage may produce the same receipt. The receipt is a record of
what the reply wrote: it counts every document the reply wrote to, live or draft,
edited or created, as soon as the reply finishes. Apply and Discard never create
or change it, and Undo never erases its turn-owned record. Pending draft lineage
shows the same card before and after Apply; only its words change.

A document the reply created in a draft counts at once, and pending draft rows
name the edited files.

A row's `scope` is where the turn wrote it: `draft` (with the draft) for a Draft chat's write, in
its fork or in a document only the draft holds, read from the write's own receipt. Its `block` is
the first block the turn's first write there changed, where the row opens the document (Review
changes at the turn's edit, for a draft). The receipt's `restore` lists the drafts whose `Restore
before` the card offers, one press each in that draft's lane; a draft whose history was cut below
the turn's start is left out (server [press](../../../../../server/server/domains/collab/.context/press.md)).

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
now. The single Undo action calls the turn-scoped reverse endpoint. There is no Redo: to put an
undone reply back, the writer asks the model to write it again. The card has one slot in its
header with a fixed width: Undo (`control: "undo"`) while a press would take something back,
"Undoing…" while it runs, "Undone" once the card's Undo ran and nothing is left for it
(`undone`), else empty, so a change of state moves nothing under the pointer. A press sends one
command, takes what it can and says nothing: no sentence about what stayed or why, and none for
a held owner (a closed, archived or Trashed Work or chat): the Undo is simply absent until the
owner reopens. Only a press that failed, or never got an answer, shows a message: the floating
pill toast (`notifyFailure` with `brief`). An old tab that still posts a Redo gets 200 `expired`.

 where they are now: pending in the
Work's document drafts, or live. Draft and live writes remain one atomic command. The card takes back
only this reply's own changes, applied ones included, and sends nothing else: the server takes back each of the
reply's writes that nobody has written over since, whole, in the room it was written in (Live or
the draft's fork), and leaves whole the ones someone has. The card never takes back a whole Apply; a Changes row's Undo and
Ctrl+Z do. Undo is offered only while a press would take something back. A write the writer has written
over (deleted or retyped all of what it put in) stays, and the card's answer is `partial`, or
`cant_undo_changed` when every write stayed; typing inside the AI's words leaves some of it, so
it still goes back around the writer's words. The receipt immediately shows Undoing while the command runs;
the Live room publishes the edit after durable commit and failures stay on the card.
Eligibility is design §2's one Undo rule (`editStays`), the one a press's Undo uses
(server [reversal](../../../../../server/server/domains/collab/.context/reversal.md)). The word "Undone" counts only the writer's own Undo, text and
tree alike: an undo the model made in the reply is part of what the reply did, so the card
offers Undo for what still stands. A Discard takes the draft's pending changes out as one
appended update in the same room; it is not receipt Undo, and the draft stays open. Only a purge
of its Work retires a draft's identity. Dependency and archived-Work guards still apply.

The card is a record, not a draft control panel. Draft Review/Apply/Discard
remain in the composer-attached `DraftDock`, the sidebar's Changes and the document's suggestion
review.

Work mutation rows consume the shared structured receipt contract. The server
supplies operation, identity, before/after facts, and a typed inverse; this
surface maps those facts through the active Lingui catalog. Idempotent receipts
do not claim a change. The chip's `state` covers the Work part too: a reply that made a Work
offers Undo while that Work still stands as the reply left it, whatever its documents did.

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
