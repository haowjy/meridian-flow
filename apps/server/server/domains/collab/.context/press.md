# The press

A draft (a `drafts` row, named by a Work or, under No Work, a root chat) is suggestion marks in
each Live document (`packages/suggestions`) plus its pending tree records. Apply or Discard pressed
on documents, folders or the whole draft is one command, `press`, over both halves
(`adapters/drizzle-press.ts`, routes `POST /api/projects/:id/press` and `/press/undo`).

## What a press does

`{ draft, verdict, items | "all", saw?, seen? }`, addressed by the draft id. Every Work and root
chat has its draft from its creation, so a press never makes one.

- **Selection.** `items` expands folders to what is under them in the Work's view. The tree half
  takes the Work's pending records on those nodes; the text half takes every document among
  them, since resolving a document with no suggestion changes nothing, except an item sent with
  `half: "tree"` (a review's tree line), whose text stays pending. `"all"` takes every
  pending record, and for text every document of the Work's project and account that can hold
  its suggestions (`documentsHolding` in `drizzle-block-text.ts`): a row whose derived cut is
  current and lists the Work in `pending_changes`, and every row `staleForReaders` (no room,
  behind the head, another extractor). That set is exact for committed writes: every live write
  moves its document's head (`allocateAdmission`), so a document the derivation hasn't caught up
  on is stale and pressed; a stale one with nothing of the Work's costs one journal read and
  resolves to nothing. While two builds overlap in a deploy, every room the newer extractor
  certified is stale to the older build, so its Apply all reads every document in scope.
- **The draft's records are read under its owner's lock**, the lock an AI write takes
  (`lockForWrite`): a read before it could miss the first tree records an AI turn admitted in
  between.
- **Tree half.** Apply is the tree Apply (`createApplyTreeOperations`, the same judge, locks and
  `apply_command_trees` rows as an Apply click). Discard is `discardTreeRecords`.
- **Text half.** For each selected document (for Apply, each that stands in Live after the tree
  half), `pressStored` (agent-edit) runs `accept` or `reject({ draft })` as one Yjs transaction, appends
  it to the Live journal as `human:<account>`, and stores in `press_text_effects` the blocks it
  changed, before and after (ProseMirror JSON, as an AI write's receipt stores its `delta`), and
  the verdict entries the resolve wrote (`suggestion_verdicts` keys, each with the id of the map
  item holding it), so its Undo takes them back with the text. A document a Discard puts in
  Trash is rejected too, so a Restore brings it back without the draft's suggestions.
- **`seen`.** The pressing tab's state vector of every live room with typing the server hasn't
  acknowledged (`unsentStateVectors`), checked first, after the lists' keys and before the selection is read:
  until Live holds them all, the press is `PressUnsynced` (503, nothing stored), and the command
  driver resends. A held vector stays held, so the typing it covers has moved its document's
  head and the selection finds the document. `seen` only waits; it adds no document to press.
  A document with no stored authority (purged) is skipped. A session left with unsent typing
  from before a version restore holds every press at 503 until the tab replaces it.
- **A resend answers only with the stored result.** The driver reads any 2xx as the command's
  result, so a resend that finds the first request still running is a 503 (sent again), and an
  id stored for another body, or settled `never`, is the routes' 409 `command_conflict`
  (`storedAnswer` in `lib/draft-review-route.ts`). The driver then resolves the id: a `never`
  settles as never-ran, but an id that holds another body's `done` resolves to that body's result,
  since resolve reads the id alone. Every command route shares this; only a client bug reaches it.
- Lock order is the Apply click's: Works, draft, lists, documents in id order, then writes.
  Deliveries and the derivation hook run after commit.

## Discard, and what goes to Trash

A Discard rejects suggestions as Apply accepts them, and settles the Work's tree records
discarded; Trash has no entry for that. Its Undo is the press's `unpress`, as Apply's is, sent
from the tab that pressed it: the notice's Undo, the sidebar's Undo step and Ctrl+Z in an open
editor share one send. After a reload nothing offers it, and the writer's own typing in the Work's
view that it rejected is gone. That is the chosen cost: keeping it would need a store of its own.

A document or folder the Work created is a whole document, not a change, so a Discard puts it in
Trash (`discardDraft` with `trash`): it is created in Live where the Work's view showed it (a
child whose created folder stays in the Work lands at the top of its source; one the Work itself
deleted stays gone), and deleted there by the presser, each topmost node taking what the Work put
inside it. Its live create carries the drafted create (`carries`, `fromDraft`), as an Apply's copy
does. The press's result records those deletes (`trashed`, stored with the command). Its Undo
(`restoreDiscard`) puts back the state from before the press: each delete still in Trash is taken
back, and so is the live create under it, so the documents leave Live and Trash and are pending in
the Work again with their text. Trash's Restore is the other way back: it brings them into Live,
and then the press's Undo finds the delete lifted and leaves them there, so whichever comes first
the other does nothing. Redo is pressing again: the Work's pending creates go to Trash as on the
first press. Work purge passes no `trash`: a purged Work's documents leave every view and `purgeUnviewed`
releases them.

## Work purge

A Work purged for good (`drizzle-work-disposal.ts`, inside the purge's transaction) has its
drafts' tree records discarded, and its suggestions, and those of the lineages the purge
deletes, rejected in every document the press's enumeration finds for them (`documentsHolding`,
over the Work's project and its creator's account: a project has one owner), with their
`suggestion_authors` entries deleted (`dropDraft`). Their verdicts stay: a tab offline through
the purge may bring back a mark of one of those changes, and a tab deletes it only while the
change has a verdict (`dropResolvedMarks`). The reject reports
every change it decided, a proposal Live has since matched included, which no review lists.
Nothing records it: nothing can take it back. Changes the writer applied or discarded earlier
keep their author entries: nothing reads them for a purged Work.
Archive, delete and Trash leave the suggestions in place and open: the press, the editor and card
Undo take an archived Work's or a trashed chat's suggestions as they take any. What archive and
Trash stop is new AI writes, at the model's write (`lockForWrite` in `model-edit-write.ts`
refuses a closed owner). A closed owner's own notes (its Scratch) stay closed, by the tree judge
below.

## Undo and Redo

`unpress` takes a press back once, in the press's own project. The tree half is `undoApply`
(Apply) or `restoreDiscard` (Discard). The text half is by content, the card Undo's rule
(`takeBack` in `domain/inverse-text.ts`): each change of the stored blocks that still stands in
the document is taken back out, written through `writeBlocks` so every item it leaves alone
keeps its identity, and the verdicts of the changes now pending again are forgotten
(`forgetVerdicts`). A change the writer typed inside since stands no more: its text and its
verdict stay as they are. A change another client resolved the same way since, whose entry now
holds that client's write (`resolvedElsewhere`), is left out of the take-back, text and verdict:
undoing one of two identical resolves would otherwise show a change pending under a verdict that
says it was resolved. It reads no deleted item: a checkpoint drops their content
([checkpoints](CONTEXT.md#authority-checkpoints-and-derivation)), and the content of an effect
outlives a version restore too. The tab's Apply and Reject inside the text are a resolve on the
editor's Y.Doc, undone by Ctrl+Z from the editor's own history. An effect whose notes are closed
is marked taken back without changing its text. A document or folder a draft created is the
draft's again after the Undo of the press that put it in Live or in Trash: pending in the Work,
in no Live row and no Trash entry. This rests on the tree's rule 15 (withdrawn nodes,
`packages/project-tree/.context/CONTEXT.md`): taking back a create a draft landed in Live is
not a delete Trash lists. Its text stays plain in its Live room, as before the press. There is no
Redo command: pressing again is the Redo. Press and unpress rows are
purged with discards after 30 days.

## The pending index

`document_block_rooms.pending_changes` holds, keyed by draft id, for each draft with suggestions
in a document, its review's change count, the chats that wrote them and whether one is no chat's, written by the
document derivation (`pendingChanges` in `packages/suggestions`). The Work's counts, the Changes
list's rows and export's pending count read it. It lags the derivation's debounce (2–10 s for
room typing), so no command takes a lagging row as its authority: the press and Work purge read
it only where its cut is current, and read the room for the rest.

## Work-only documents

A document that exists only in a Work is the tree's drafted create; its text is plain in Live,
not suggestions (`model-edit-write.ts`, `existsOnlyIn`). Applying the create makes it
visible; a press's Discard puts it in Trash. The browser opens it in its Live room as plain text:
the project's list does not have it, so the opener admits it as the Work's (`workOnly`) and the
Yjs gateway admits the room through `documentSync.draftsHolding`.

## Not covered yet

- No per-document grant check: the press is the draft owner's, like Apply all.
- Older builds read a withdrawn node as in Trash (the Undo's delete looks like any delete):
  nothing is lost, and the node is pending in the Work there too.
