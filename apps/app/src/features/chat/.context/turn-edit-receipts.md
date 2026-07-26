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
