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
  takes the Work's pending records on those nodes; the text half takes every document among
  them, since resolving a document with no suggestion changes nothing, except an item sent with
  `half: "tree"` (a review's tree line), whose text stays pending. `"all"` takes every
  pending record, and for text the documents the pending index lists for the Work plus the ones
  in `seen`.
- **The branch is read under the owner's lock**, where it is made and closed: a branch read
  before it could miss the first tree records an AI turn admitted in between.
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

`unpress` takes a press back once, in the press's own project. The tree half is `undoApply`
(Apply) or `restoreDiscard` (Discard). The text half is a `Y.UndoManager` undo built from the
stored ranges: it restores what the press removed and removes what it made Live, and keeps
anything typed since where it was typed: the press writes only the text it deletes and the marks
it removes (`resolveStored`), so text typed inside a resolved word sits in items the press kept.
The tab's Apply and Reject inside the text are the same resolve, undone by Ctrl+Z. An effect whose
document's authority generation changed (a version restore), or whose notes are closed, is
marked taken back without changing its text. A document the press created stays in Live on
Undo of Apply. There is no Redo command: pressing again is the Redo. Press and unpress rows are
purged with discards after 30 days.

## The pending index

`document_block_rooms.pending_changes` holds, for each Work with suggestions in a document, its
review's change count, the chats that wrote them and whether one is no chat's, written by the
document derivation (`pendingChanges` in `packages/suggestions`). The Work's counts, the Changes
list's rows and export's pending count read it. The press reads it only for a whole Work, scoped to the Work's
project and account documents. It lags the derivation's debounce (2–10 s for room
typing), so it never decides what a named press touches. A whole-Work press can miss a
document typed into in another tab seconds before; the pressing tab's open documents come in
through `seen`.

## Work-only documents

A document that exists only in a Work is the tree's drafted create; its text is plain in Live,
not suggestions (`model-edit-write.ts`, `existsOnlyInWork`). Applying the create makes it
visible; discarding it hides it. The browser opens it in its Live room as plain text: the
project's list does not have it, so the opener admits it as the Work's (`workOnly`) and the Yjs
gateway admits the room through `documentSync.workOnlyOwners`. The tab follows the Work's row, so
a Discard closes the room and its Undo opens it again.

## Not covered yet

- Trash's discard list reads `draft_discards`, so a press Discard does not show there; Undo is
  the press's own.
- No per-document grant check: the press is the Work owner's, like Apply all.
- A press Apply leaves `apply_command_trees.created_heads` as the tree Apply's placeholders:
  the press never calls `recordCreatedHeads`, since its Undo keeps every created document in
  Live. Anything that comes to read those heads for a press must record them first.
