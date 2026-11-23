# The press

A draft (a `drafts` row, named by a Work or, under No Work, a root chat) is its pending tree
records and its fork rooms (`document_forks`, design §2). Apply or Discard, pressed on one change,
a document, a draft or every draft of a Work, is one command, `press`
(`adapters/drizzle-press.ts`, routes `POST /api/projects/:id/press` and `/press/undo`). There is
no folder scope.

## What a press does

`PressRequest` (`@meridian/contracts/drafts`): `{ verdict, scope, saw?, liveVersions? }`. A
`change` or `document` scope names its document by `DraftItemKey`; `draft` names one draft;
`work` takes every living draft of the Work, one after another in draft id order, each on Live as
the one before left it. Every Work and root chat has its draft from its creation, so a press
never makes one.

- **The text half** runs first, per document of the draft in scope that has a fork row (a
  `draft` or `work` scope takes the forks flagged pending). It reads the fork room as a command
  copy (its own peer, carrying its forwarded copy of Live), runs `applyBlocks` or
  `discardBlocks` (a `change` scope selects the change by any member id), commits Live's room
  then the fork's under the message `press:<id>`, and stores each change's `PressedChange` in
  `press_changes` (command, draft, document) for its Undo. It then sets the fork's `pending`
  flag from the copy: an Apply writes only Live, so no fork save would.
- **`liveVersions`** stamps the record of a removal the press applies, nothing else: the server
  never waits for or refuses a press over the tab's typing. A document it names no version for
  counts as never shown, so a removal there does not land.
- **The tree half.** A `document` scope takes that node's pending records; `draft` and `work`
  take every pending record of each draft; a `change` takes none. `saw` is the cut of the lists
  the review was drawn from: records admitted after it stay pending. Apply is the tree Apply
  (`createApplyTreeOperations`, the same judge, locks and `apply_command_trees` rows); Discard is
  `discardTreeRecords`. The tree lists take a command name once, so each draft's part is named
  `<command>_<draft>` there.
- **The draft's records are read under its owner's lock**, the lock an AI write takes
  (`lockForWrite`): a read before it could miss the first tree records an AI turn admitted in
  between.
- **A resend answers only with the stored result.** The driver reads any 2xx as the command's
  result, so a resend that finds the first request still running is a 503 (sent again), and an
  id stored for another body, or settled `never`, is the routes' 409 `command_conflict`
  (`storedAnswer` in `lib/draft-review-route.ts`). The driver then resolves the id: a `never`
  settles as never-ran, but an id that holds another body's `done` resolves to that body's result,
  since resolve reads the id alone. Every command route shares this; only a client bug reaches it.
- Lock order is the Apply click's: Works, drafts in id order, lists, documents in id order, then
  writes.
  Deliveries run after commit.

## Discard, and what goes to Trash

A Discard settles the Work's tree records discarded; Trash has no entry for that. Its Undo is the
press's `unpress`, as Apply's is, sent from the tab that pressed it: the notice's Undo and the
sidebar's Undo step share one send. After a reload nothing offers it. That is the chosen cost:
keeping it would need a store of its own.

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
drafts' tree records discarded. Archive, delete and Trash leave a draft's records pending: the
press takes an archived Work's or a trashed chat's draft as it takes any. What archive and Trash
stop is new AI writes, at the model's write (`lockForWrite` in `model-edit-write.ts` refuses a
closed owner). A closed owner's own notes (its Scratch) stay closed, by the tree judge below.

## Undo and Redo

`unpress` takes a press back once, in the press's own project, draft by draft, newest first. Per
document, `undoPress` reads the press's `press_changes` rows: each change goes back whole or stays
whole (`editStays`), each room its own, committed under `press:<undo id>`. A change that stays is
in the answer's `stayed`, with who wrote over it, read from the commit messages on its text since
the press: no message is the writer, `turn:<id>` a chat (by its ref), `press:` another press.
Then the tree half: `undoApply` (Apply) or `restoreDiscard` (Discard) on that draft's part, with
the Trash deletes whose nodes its creates made. A deleted draft's text has nothing to come back
to; a purged draft's rows went with it.

A document or folder a draft created is the draft's again after the
Undo of the press that put it in Live or in Trash: pending in the Work, in no Live row and no
Trash entry. This rests on the tree's rule 15 (withdrawn nodes,
`packages/project-tree/.context/CONTEXT.md`): the press's Undo takes back such a create with a
withdrawal, a delete Trash does not list. Any other Undo of it (the model's `undo`) still puts it
in Trash, since nothing makes it pending again. A Trash Restore of part of a discarded folder
keeps that part, and the folders above it, in Live on the press's Undo. Its text stays plain in
its Live room, as before the press. There is no Redo command: pressing again is the Redo. Press
and unpress rows are purged with discards after 30 days.

## Work-only documents

A document that exists only in a Work is the tree's drafted create; its text is plain in Live
(`model-edit-write.ts`, `existsOnlyIn`). Applying the create makes it
visible; a press's Discard puts it in Trash. The browser opens it in its Live room as plain text:
the project's list does not have it, so the opener admits it as the Work's (`workOnly`) and the
room gateway admits the room through `documentSync.draftsHolding`.

## Not covered yet

- No per-document grant check: the press is the draft owner's, like Apply all.
- The review list's readers (the Work's text counts, retention holds, `documentsHolding`,
  `listDraftTextChanges`) still read `document_block_rooms.pending_changes`, which nothing writes;
  they move onto `document_forks` next (plan step 5).
- Older builds read a withdrawn node as in Trash (the Undo's delete looks like any delete):
  nothing is lost, and the node is pending in the Work there too.
