# The press

A draft (a `drafts` row, named by a Work or, under No Work, a root chat) is its pending tree
records and its fork rooms (`document_forks`, design §2). Apply or Discard, pressed on one change,
a document, a draft or every draft of a Work, is one command, `press`
(`adapters/drizzle-press.ts`, routes `POST /api/projects/:id/press` and `/press/undo`). So is a
Draft chat turn's restore, its card's `Undo turn`. There is no folder scope.

## What a press does

`PressRequest` (`@meridian/contracts/drafts`): `{ verdict, scope, saw?, liveVersions? }`, where
`PressAction` pairs the verdict with the scopes it takes: `apply` and `discard` take the review
scopes below, and `restore` takes only `{ kind: "turn", turn, draft }`. The route's schema is the same
union, so a mismatched pair does not parse. A
`change` or `document` scope names its document by `DraftItemKey`; `draft` names one draft;
`work` takes the drafts it names that are still the Work's and living, one after another in draft
id order, each on Live as the one before left it. It names them because the browser orders it after
earlier presses of exactly those drafts: a draft added since the tab listed the Work waits for its
own press. Every Work and root chat has its draft from its creation, so a press
never makes one.

- **The text half** runs first, per document of the draft in scope that has a fork row (a
  `draft` or `work` scope takes the forks flagged pending). A loaded fork writes its row and flag
  only when it saves, on a 2 s debounce, so the press first saves its drafts' loaded forks
  (`saveLoadedForks`, outside its transaction): a tab's first words in a draft, acknowledged just
  before the press (always the case for a press made while away, whose typing arrives with the
  Join), would otherwise have no row yet and be skipped. It reads the fork room as a command
  copy (its own peer, carrying its forwarded copy of Live), runs `applyBlocks` or
  `discardBlocks` (a `change` scope selects the change by any member id), commits Live's room
  then the fork's by the press (`commitMessage`'s `by: { press: <id> }`), and stores each change's `PressedChange` in
  `press_changes` (command, draft, document) for its Undo. It then sets the fork's `pending`
  flag from the copy: an Apply writes only Live, so no fork save would.
- **`liveVersions`** stamps the record of a removal the press applies, nothing else: the server
  never waits for or refuses a press over the tab's typing. A document it names no version for
  counts as never shown, so a removal there does not land.
- **The tree half.** A `document` scope takes that node's pending records; `draft` and `work`
  take every pending record of each draft; a `change` takes none. `saw` is the cut of the lists
  the review was drawn from: records admitted after it stay pending. A `saw` past what the
  server's list holds counts what the server holds of it, as `liveVersions` counts only the Live
  the server holds: a record the tab saw that has not reached the server is not there to land, and
  stays pending when it arrives. The press never waits for the tab's sync. Apply is the tree Apply
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

## Restore: the turn card's Undo turn

`restore` on a turn in one draft takes back what the turn did there that the draft still holds,
as one press: its writes into the draft's text and its tree changes still pending there. What
the writer applied stays in the manuscript. A turn that wrote in several drafts is one press per
draft, each in that draft's lane on the tab (`press:<draft>`), so it is ordered after an Apply or
Discard pressed on the same draft before it. The plan (`adapters/drizzle-turn-restore.ts`,
`restorePlan`) is read once and shared with the card (`restoreStates`): `TurnReceiptChip.restore`
offers it in the drafts where pressing would change something now (a write of the turn would go
back, or a tree change of it is still pending), so a turn already restored or undone there is
not offered, and `restored` names the restore in force per draft (the latest done `restore` press
that changed something and has no done `unpress`), so every tab and a reload read the same state.

- **Rooms.** The turn's parts whose `origin` names the draft: its fork of a document, or the Live
  room of a document only the draft still holds (a Draft chat writes such a document there). A
  document the turn wrote while only the draft held it, and the writer has since applied, is the
  manuscript's: it stays.
- **The writes** are the turn's stored edits (`document_edit_parts.edit`) in those rooms, newest
  first, taken back by design §2's Undo rule (`undoInRooms`, `takeBack`): each goes back whatever
  was written since, except one older than the room's history cutoff (§4), which can't (`holdsEdit`).
  A part already taken back (by an earlier restore, the model's undo in a later turn or the
  writer's revert) is not taken again: taking it again would put the text it deleted back a
  second time. The model's undo within the turn is one of the turn's writes: it goes back before
  the write it took, so the draft ends as it was before the turn, not with the withdrawn words. A fork
  copy is carried forward to today's Live first. Live's manuscript is never written: text an
  Apply already put there stays in Live, and taking it out of the draft is a pending change.
- **The tree changes** are the turn's drafted tree receipts' records (`tree_edit_receipts`, the
  newest copy of each after a restored Discard, `newestDrafted`) still pending in the draft. They
  are discarded by the Discard's tree half (`discardTreeRecords` with `records` and `trash`), with
  whatever stands on a node they create: a rename, move or delete leaves the draft, and a node the
  turn created goes to Trash with its text, so no write into it is taken back. A change the writer
  applied stays in Live.
- The answer names only the documents and nodes the press changed, so a press that changed
  nothing names none and makes no Undo step.

What a restore took back is recorded in the one ledger every Undo reads, `document_edits`, not
in `press_changes`: one `undo` receipt per document (`actionId` and `commandId` the press), a part
per room naming the parts it took (`targets`) and carrying the room's edit, its `origin` the room.
So a second restore from a stale tab, the card and the model's `undo` and `revert` all find those
parts taken, by the same `notTakenBack` / `effectiveActionIndex` rule. The plan is read inside the
press, under the draft's key and its Work's, which a model's Undo of the same writes also holds.
The Undo is the press's `unpress`: it takes the restore's own parts back (`restoredParts`, those no
Undo has taken since) in their rooms and records an `undo` receipt with the turn's `turn_id` and
its edit, so the text it brings back is the turn's again, and pressing the restore again (the
Redo) takes that receipt's parts back, never the turn's first writes, whose text now lives
elsewhere. The model's `undo` of a write a restore took reads it taken even after the restore's
Undo: the writer brought it back, and it stays the writer's to take again. The tree changes
come back by `restoreDiscard`. While a restore is in force, the turn
card reads each tree change it took as `undone` (`TurnDraftState`), by the command that settled
it.

The card's own Undo (`reverse_turn`, [reversal](reversal.md)) takes none of this: it takes the
turn's writes and tree changes outside a draft, so a Draft chat's reply has one action on its
card. Restore takes back each write by the Undo rule, never by putting a text doc back to the
turn's first version: that would also reverse whatever came after in the doc (half of a later
split).

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
document, `undoPress` reads the press's `press_changes` rows (a restore's Undo reads its receipts
instead, above): every change goes back, whatever
was written since (design §2, "An Undo always runs"), each room its own, committed by the Undo's
press (`commit-message.ts`). A change older than the room's history cutoff can't go back and is
left as it is, silently.
Then the tree half: `undoApply` (Apply) or `restoreDiscard` (Discard, restore) on that draft's part, with
the Trash deletes whose nodes its creates made. A deleted draft's text comes back like any
other's (Delete draft keeps its rows); a purged draft's forks went with it, so its text has nothing
to come back to.

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
(`draft_tree_nodes.exists_only_in_draft`, read by `agentRoomFor` in `adapters/drizzle-agent-room.ts`). Applying the create makes it
visible; a press's Discard puts it in Trash. The browser opens it in its Live room as plain text:
the project's list does not have it, so the opener admits it as the Work's (`workOnly`) and the
room gateway admits the room through `documentSync.draftsHolding`.

## Not covered yet

- No per-document grant check: the press is the draft owner's, like Apply all.
- Older builds read a withdrawn node as in Trash (the Undo's delete looks like any delete):
  nothing is lost, and the node is pending in the Work there too.
