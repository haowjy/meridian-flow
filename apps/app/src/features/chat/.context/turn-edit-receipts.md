# Turn edit receipts

This page defines the chat contract for turn-edit records. The card has no Undo or Redo: review actions live in draft review.

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
scope, and the settled trail supplies historical titles, word totals, and change rows. Both
direct and draft lineage may produce the same receipt. The receipt is a record of
what the reply wrote: it counts every document the reply wrote to, live or draft,
edited or created, as soon as the reply finishes. Apply and Discard never create
or change it, and it has no Undo or Redo. Pending draft lineage
shows the same “Edited N documents” card before Apply.

This checkout diverges for created documents ([#843][issue-843], fix planned):
the count reads edit targets that resolve to a live address, and a document the
reply created in a draft has none until Apply reveals it. A reply that only
creates draft documents shows no card until Apply makes one appear. Settled live trails
add retained Before/After excerpts; pending draft rows name the edited files.

The word totals diverge as well. The card reads them from the mutable change
trail (`changeTrail.wordsAdded` and `wordsRemoved`), and Apply's settlement
writes those, so a finished reply's totals appear or change after Apply. The
merge Apply can also count the writer's own draft typing that was published with
it. The planned fix renders the receipt from a snapshot of the reply's targets
and word deltas taken when the reply finishes ([#843][issue-843], with
[#844][issue-844]'s split of historical from reversible targets).

The receipt reads server lineage, never tool results. A binary copy (an upload
such as a PDF, copied at once with no write handle) leaves no journal row, so it
is not counted as an edit. Captured Before/After excerpts remain visible after
document loss and reload, and deleted live anchors degrade navigation without
discarding the receipt.

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
[issue-844]: https://github.com/haowjy/meridian-flow/issues/844
