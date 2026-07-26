# Turn edit receipts

This page defines the chat contract for committed turn-edit records and reversal.

The per-turn receipt is a quiet, default-collapsed record for committed
document edits. Its line names one document or counts several and adds settled
`+added −removed words` totals when the trail shell has them. Live
single-document headers derive the same URI title without inventing a delta.
The shell carries header metadata, so collapse never triggers a detail fetch.
Expanding shows live documents and every authorized durable trail row. Each row
renders concise retained Before and/or After excerpts without a nested
scrollport. A conversation reveal opened from an editor peer mark expands the
receipt and brings its exact target row into view.

`AssistantTurn` combines server-owned facts: full turn lineage supplies document
scope, the durable receipt supplies whole-turn Undo/Redo authority, and the
settled trail supplies historical titles, word totals, and change rows. Both
direct and draft lineage may produce the same receipt. A draft proposal
with neither live lineage nor settled trail documents produces no card; after
Apply, the committed receipt remains visible across reload.

The single Undo/Redo action calls the turn-scoped reverse endpoint. Receipt state
(`live-active`, `branch-active`, reversed, dependent, or expired) decides whether
it is available. Unavailable actions render a compact `Can't undo` pill; the
server-derived reason appears only after expansion. Captured Before/After
excerpts remain visible after document loss and reload, and deleted live anchors
degrade navigation without discarding the receipt.

A reversal command can race the projected receipt and return a semantic refusal
with HTTP 200. The mutation invalidates the turn query, expands the receipt, and
retains the returned reason while refreshed lineage withdraws the action. Do not
reduce the result to transport success or clear the local reason merely because
the refreshed control becomes `view_change`; both recreate click-and-nothing.
Unexpected transport failures remain retryable and do not replace server-derived
recovery state.

The card is a record, not a draft control panel. Draft Review/Apply/Discard
remain exclusively in the composer-attached `DraftDock` and inline review
surface.

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

An unavailable stage ends the request where its parent left the writer: a
change row that never renders still leaves them on its turn, a turn that never
arrives still leaves them in the thread. Nothing copies the pending request into
component state — display without the lifecycle is what let a request outlive
everything that could complete it. A stage deadline in the controller is only a
backstop for the case no surface can report: a stage whose surface never mounts.
