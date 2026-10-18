# Turn edit receipts

This page defines the chat contract for turn-edit records and reversal.

The per-turn receipt is a quiet, default-collapsed record for live and pending draft
document edits. Its header counts documents ("Edited 1 document") and never
names one, and adds settled `+added −removed words` totals when the trail
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

This checkout diverges for created documents ([#843][issue-843], fix planned):
the count reads edit targets that resolve to a live address, and a document the
reply created in a draft has none until Apply reveals it. A reply that only
creates draft documents shows no card until Apply makes one appear. Settled live trails
add retained Before/After excerpts; pending draft rows name the edited files.

The receipt reads server lineage, never tool results. A binary copy (an upload
such as a PDF, copied at once with no write handle) leaves no journal row, so it
is not counted as an edit and offers no Undo. Undoing a text copy reverses its
staged create and leaves an empty document, the same as undoing any create
(document delete is not in the tool surface); the receipt shows it as undone
and the document stays openable.

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
recreate click-and-nothing.

Every refusal is visible, and the receipt's reason line is where it shows.
Copy covers the whole wire status union through an exhaustive switch that fails
the build when a status is added, and a command that never reached a status at
all — rejected fetch, HTTP error envelope — gets its own retry line naming the
command the writer pressed. `cant_undo_dependent` reads the same sentence
whether it arrives as receipt state or as a refused command, and points at
viewing the change, which is what expansion puts on screen. A refused command
never leaves the card unchanged.

Undo reverses the turn's remaining edits where they are now: pending in the
Work draft or already applied to live. Branch and live writes remain one atomic
command. The receipt immediately shows Undoing/Redoing while the command runs;
Yjs publishes the edit after durable commit and failures stay on the card.
Pending Undo preserves its generation so Redo can restore it. Review Discard is
terminal, not Undo: discarded rows never authorize Redo even while other changes
keep the draft open. Apply/Discard generation resets withdraw old branch
authority without affecting applied live authority. The server's existing
dependency and archived-Work guards still apply.

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
