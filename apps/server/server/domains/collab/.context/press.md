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
- **Text half.** For each selected document that stands in Live after the tree half,
  `pressStored` (agent-edit) runs `accept` or `reject({ draft })` as one Yjs transaction, appends
  it to the Live journal as `human:<account>`, and stores its inserted and deleted id ranges in
  `press_text_effects` with the authority generation. The ranges hold the verdicts the resolve
  recorded (`suggestion_verdicts`), so its Undo takes them back with the text. A document the press leaves out of Live
  (a discarded create) keeps its text untouched.
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

## Discard is not in Trash

A Discard rejects suggestions as Apply accepts them, and settles the Work's tree records
discarded; Trash has no entry for it. Its only Undo is the press's `unpress`, as Apply's is, sent
from the tab that pressed it: the notice's Undo, the sidebar's Undo step and Ctrl+Z in an open
editor share one send. After a reload nothing offers it, and what it took is gone: the writer's own
typing in the Work's view, and a document the Work created (no view shows it, and
`purgeUnviewed` releases its content). That is the chosen cost: keeping it would need a store of
its own.

## Work purge

A Work purged for good (`drizzle-work-disposal.ts`, inside the purge's transaction) has its
drafts' tree records discarded, and its suggestions, and those of the lineages the purge
deletes, rejected in every document the press's enumeration finds for them (`documentsHolding`,
over the Work's project and its creator's account: a project has one owner), with their
`suggestion_authors` and `suggestion_verdicts` entries deleted (`dropDraft`). The reject reports
every change it decided, a proposal Live has since matched included, which no review lists.
Nothing records it: nothing can take it back. Changes the writer applied or discarded earlier
keep their entries: nothing reads them for a purged Work.
Archive, delete and Trash leave the suggestions in place and open: the press, the editor and card
Undo take an archived Work's or a trashed chat's suggestions as they take any. What archive and
Trash stop is new AI writes, at the model's write (`lockForWrite` in `model-edit-write.ts`
refuses a closed owner). A closed owner's own notes (its Scratch) stay closed, by the tree judge
below.

## Undo and Redo

`unpress` takes a press back once, in the press's own project. The tree half is `undoApply`
(Apply) or `restoreDiscard` (Discard). The text half is a `Y.UndoManager` undo built from the
stored ranges: it restores what the press removed and removes what it made Live, and keeps
anything typed since where it was typed: the press writes only the text it deletes and the marks
it removes (`resolveStored`), so text typed inside a resolved word sits in items the press kept.
The tab's Apply and Reject inside the text are the same resolve, undone by Ctrl+Z. An effect whose
document's authority generation changed (nothing moves one today; a version restore is an
ordinary edit), or whose notes are closed, is marked taken back without changing its text. A document the press created stays in Live on
Undo of Apply. There is no Redo command: pressing again is the Redo. Press and unpress rows are
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
visible; discarding it hides it. The browser opens it in its Live room as plain text: the
project's list does not have it, so the opener admits it as the Work's (`workOnly`) and the Yjs
gateway admits the room through `documentSync.draftsHolding`. The tab follows the Work's row, so
a Discard closes the room and its Undo opens it again.

## Not covered yet

- No per-document grant check: the press is the draft owner's, like Apply all.
- A press Apply leaves `apply_command_trees.created_heads` as the tree Apply's placeholders:
  the press never calls `recordCreatedHeads`, since its Undo keeps every created document in
  Live. Anything that comes to read those heads for a press must record them first.
