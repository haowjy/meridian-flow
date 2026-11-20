# The press (suggestion mode)

With `FLOW_SUGGESTIONS=1`, a Work's draft is suggestion marks in each Live document
(`packages/suggestions`) plus the Work's pending tree records. Apply or Discard pressed on
documents, folders or the whole Work is one command, `press`, over both halves
(`adapters/drizzle-press.ts`, routes `POST /api/projects/:id/press` and `/press/undo`).

## What a press does

`{ owner, verdict, items | "all", saw?, seen? }`, addressed by the Work's owner key
(`work:<id>` or `lineage:<root>`), not by a branch: a Work with suggestions and no tree change
has no branch row.

- **Selection.** `items` expands folders to what is under them in the Work's view. The tree half
  takes the Work's pending records on those nodes; the text half takes those nodes that the
  pending index lists for the Work. `"all"` takes every pending record and every indexed
  document.
- **Tree half.** Apply is the tree Apply (`createApplyTreeOperations`, the same judge, locks and
  `apply_command_trees` rows as an Apply click). Discard is `discardTreeRecords`.
- **Text half.** For each selected document that stands in Live after the tree half,
  `pressStored` (agent-edit) runs `accept` or `reject({ work })` as one Yjs transaction, appends
  it to the Live journal as `human:<account>`, and stores its inserted and deleted id ranges in
  `press_text_effects` with the authority generation. A document the press leaves out of Live
  (a discarded create) keeps its text untouched.
- **`seen`.** The pressing tab's state vector per open document. Until Live holds it, the press
  is `ApplyClickUnsynced` (503, nothing stored); the command driver resends.
- Lock order is the Apply click's: Works, branch, lists, documents in id order, then writes.
  Deliveries and the derivation hook run after commit.

## Undo and Redo

`unpress` takes a press back once. The tree half is `undoApply` (Apply) or `restoreDiscard`
(Discard). The text half is a `Y.UndoManager` undo built from the stored ranges: it restores what
the press removed and removes what it made Live, and leaves anything typed since in place. An
effect whose document's authority generation changed (a version restore) is skipped. A
document the press created stays in Live on Undo of Apply. There is no Redo command: pressing
again is the Redo. Press and unpress rows are purged with discards after 30 days.

## The pending index

`document_block_rooms.pending_changes` is `{ owner: count }` per document, written by the
document derivation from `pending(doc)`. It lags the derivation's debounce (2–10 s for room
typing), so a whole-Work press can miss a document typed into seconds before. A per-item press
does not depend on the lag for an open document: its `seen` vector makes the server wait.

## Work-only documents

A document that exists only in a Work is the tree's drafted create; its text is plain in Live,
not suggestions (`model-edit-write.ts`, `existsOnlyInWork`). Applying the create makes it
visible; discarding it hides it. The browser still opens such a document through the old draft
review route; moving that onto Live is the review UI's work.

## Not covered yet

- Trash's discard list reads `draft_discards`, so a press Discard does not show there; Undo is
  the press's own.
- No per-document grant check: the press is the Work owner's, like Apply all.
