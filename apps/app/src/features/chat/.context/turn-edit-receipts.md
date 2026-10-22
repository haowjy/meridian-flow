# Turn edit receipts

This page defines the chat contract for turn-edit records and reversal.

The per-turn receipt is a quiet, default-collapsed record for live and pending draft
document edits, moves and deletes. Its header counts documents ("Edited 1 document",
or "Changed 1 document" once the turn moved or deleted one) and never names one, and adds settled `+added −removed words` totals when the trail
shell has them; document names belong to the expanded rows, which navigate.
The shell carries header metadata, so collapse never triggers a detail fetch.
Expanding shows edited documents and every authorized durable trail row. Each row
renders concise retained Before and/or After excerpts without a nested
scrollport. A conversation reveal opened from an editor peer mark expands the
receipt and brings its exact target row into view.

`AssistantTurn` combines server-owned facts: full turn lineage supplies document
scope, the durable receipt supplies whole-turn Undo/Redo authority, and the
settled trail supplies historical titles, word totals, and change rows. Both
direct and draft lineage may produce the same receipt. The receipt is a record of
what the reply wrote: it counts every document the reply wrote to, live or draft,
edited or created, as soon as the reply finishes. Apply and Discard never create
or change it, and Undo never erases its turn-owned record. Pending draft lineage
shows the same “Edited N documents” card before Apply.

Created-document counts currently violate that contract ([#843][issue-843]):
the count reads edit targets that resolve to a live address, and a document the
reply created in a draft has none until Apply reveals it. A reply that only
creates draft documents shows no card until Apply makes one appear. Settled live trails
add retained Before/After excerpts; pending draft rows name the edited files.

The receipt reads server lineage, never tool results. A binary copy (an upload
such as a PDF, copied at once with no write handle) leaves no journal row, so it
is not counted as an edit and offers no Undo. Undoing a text copy reverses its
staged create content and leaves the created document empty (#843: a create has
no tree entry yet); the receipt shows it as undone and the document stays openable.

A document the turn moved or deleted carries its net tree line in lineage, and
its row says so: "Moved ch4 to ch4-old" (the folder or section kept only when it
tells the destination apart, never a Work handle, #914) or "Deleted ch2". The
row is a record: it keeps its words after Undo, as text rows do. A deleted
document's row is not a door, because its old address may hold another document
now. A stopped reply's rolled-back moves and deletes get no line; the parts list
says "Rolled back".

The single Undo/Redo action calls the turn-scoped reverse endpoint. Receipt state
(`live-active`, `work-active`, reversed, dependent, or expired) decides whether
it is available. Unavailable actions render a compact `Can't undo` pill; the
server-derived reason appears only after expansion. Captured Before/After
excerpts remain visible after document loss and reload, and deleted live anchors
degrade navigation without discarding the receipt.

A reversal command can race the projected receipt and return a semantic
unavailable outcome with HTTP 200. The mutation invalidates the turn query,
expands the receipt, and retains the returned reason while refreshed lineage
withdraws the action. Do not reduce the result to transport success or clear the
local reason merely because the refreshed control becomes `view_change`; both
hide the semantic refusal after a successful HTTP response.

Every refusal is visible, and the receipt's reason line is where it shows.
Skipped parts and refusals are worded in `turn-receipt-copy.ts` from typed
causes (`TurnInverseSkipCause`, the `location_taken` / `folder_missing` /
`superseded` statuses); the card never prints server prose. A move or delete
that can't come back names the cause and the next step ("Can't undo: another
document is at ch2. Move or rename that document, then try again."), and the
parts list doesn't repeat what that line already says.
Copy covers the whole wire status union through an exhaustive switch that fails
the build when a status is added, and a command that never reached a status at
all — rejected fetch, HTTP error envelope — gets its own retry line naming the
command the writer pressed. `cant_undo_dependent` reads the same sentence
whether it arrives as receipt state or as a refused command, and points at
viewing the change, which is what expansion puts on screen. A refused command
never leaves the card unchanged.

Undo reverses the turn's remaining edits where they are now: pending in the
Work's document drafts or already applied to live. Draft and live writes remain one atomic
command. The receipt immediately shows Undoing/Redoing while the command runs;
Yjs publishes the edit after durable commit and failures stay on the card.
Inverse eligibility comes from the inverse kernel's identity classification.
The derived applied/pending/discarded disposition chooses a skipped part's copy,
never grants or refuses Redo; in particular, the model's own Undo must remain
redoable when the kernel allows it. Review text Discard is a separate local
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

`TurnEditsReceipt` renders every authorized trail change in ordinal order. The
one-shot *Open conversation* reveal only expands the receipt and emphasizes the
target row; it does not change which rows are mounted.

## Reveal staging

A reveal target names a thread, a turn, or a change row — never a partial path.
It is handed down one stage at a time, and the surface holding a stage reports
`landed` or `unavailable` once its own data settles:

| Stage | Owner | Lands | Reports unavailable when |
|---|---|---|---|
| thread | project shell (`useConversationRevealRouting`) | points the current screen's chat surface at the thread | never — a shell cannot fail to aim a surface |
| turn | transcript (`useTurnRevealLanding`) | centers the turn's row, waiting for a parked viewport to be measured | settled history holds no such turn |
| change | turn receipt (`TurnEditsReceipt` → `ChangeViewRows`) | expands the receipt and scrolls the row into view | no authorized trail, the evidence request failed, or the loaded evidence no longer carries the change |

A turn target may also name a `toolCallId`, as a Changes row's chat link does.
After the turn lands, the transcript scrolls to that tool's row and flashes it
(`block-reveal-flash`). A row inside a closed process fold is never opened for
the reveal: the fold's header takes the scroll and the flash, and the turn stays
the landing when neither is found. The landing also releases follow so a
transcript that has just mounted does not pin back to the live edge.

An unavailable stage ends the request where its parent left the writer: a
change row that never renders still leaves them on its turn, a turn that never
arrives still leaves them in the thread. Nothing copies the pending request into
component state — display without the lifecycle is what let a request outlive
everything that could complete it. A stage deadline in the controller is only a
backstop for the case no surface can report: a stage whose surface never mounts.

[issue-843]: https://github.com/haowjy/meridian-flow/issues/843
