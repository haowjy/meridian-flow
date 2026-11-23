# Draft review runtime

A Work's draft is a fork room of each document it changed, plus its tree records (a document or
folder it created, renamed, moved or deleted). A draft page binds the fork room
(`ContextDocumentHost`); a document only the Work has is plain text in its own Live room.

## Review changes

Review changes is a state of the page's address, not of any store: `review` names what the draft
is compared against (`live`, another draft's id, or `file:<doc>`) and `change` the change in focus
(`features/project/routing/project-address.ts`). The side, which has no address, keeps the same two
fields in its stored slot (`ShownDocument`). `useHostReviewMode` reads whichever applies into one
`ReviewMode` per host, and nothing else records whether a pane is reviewing.

- **Opening** a review pushes a history entry marked with where it came from
  (`reviewOpenedFromMark`) and moves the focus to the stepper; **Close** and Esc go Back when that
  entry is the page's own, and otherwise replace. The stepper, a press and the target picker
  replace. Esc is one handler per host (`ReviewEscapeScope`) at page scope, after any menu, dialog
  or field that handles it.
- **The controls** (`ReviewBar`) take the review line above the toolbar, so the formatting
  controls stay whole: the layout toggle, the chapter's `Discard` · `Apply` (named "this chapter"
  for assistive tech), the stepper and Close. A pane under 720px offers Inline only and an icon
  Close; a line too narrow gives up in steps (`fitReviewLine`,
  [the identity bar](../../project/context/.context/document-identity-bar.md)).
- **The rows** are the editor's: `ReviewChangesExtension` (`core/editor/extensions/review-changes`)
  reads `changedBlocks` of the fork against Live 150 ms after typing pauses, or after Live's copy
  imports (a press, Live typed in elsewhere), and maps its decorations through the typing in
  between. It publishes the rows to the host's `ReviewSurface` for the review line and "Review N changes". The layout
  (Inline or Side by side) is a device preference, not in the address; Side by side gives every
  row both columns, an empty cell where one side has nothing.
- **A row's pair** presses that change (`startChange`, scope `change`). The row hides at once, the
  focus moves to the next row.
- **Every press is a Ctrl+Z step** in each editor open on its documents, pushed as it is made in
  `usePressCommands.run`, the one path every press takes (margin, bar, tree row, Changes rows):
  `EditorPressStep`. Its Undo waits for the press's answer, then sends the press's Undo; Redo
  presses again. An Undo from the sidebar or a notice ends the press (`PressEntries`), which
  takes the editor's step away too; one Ctrl+Z took back stays for Redo.
- **Pressing the last change closes the review** at once. A read that comes back empty closes
  it only once the draft's list agrees (`ReviewMode.listed`): a fork still syncing reads empty
  before the list does.
- **The stepper crosses chapters**: past either end it opens the next or previous chapter with
  changes, ‹ at its last change.
- **A plain draft** shows "Review N changes" (`ReviewChangesButton`), counted by the same extension
  in count mode, which paints nothing.

The tree half of a reviewed document is its row in the pane (`ReviewTreeRow`): Deleted, New, or
"Was <path>". The chapter's pair is on the review line.

## Presses

An Apply or Discard is a press (`usePressCommands`, `client/query/press-commands.ts`) with a scope:
one change, one document, the draft, or the Work. It is sent through the command driver, which
resends it under the same id until the server answers. Before the first send the driver waits on
`ready`: the fork's and Live's rooms have had this tab's edits acknowledged
(`registry.whenSentAcknowledged`), so the server presses what the writer saw.

The Changes list, the chat strip and a page read the owner's draft list (`useOwnerDrafts`). It is
re-read when the server wakes the owner (`useProjectWake`) and in each of the account's tabs when a
press or its Undo settles (`refreshDraftReads`). A pressed row leaves while the press is in flight
(`DraftCommandOwner.hold`) and comes back with a pill if the press fails.

## Account command lifetime

`AccountFeatureLifetime.draftCommands` (`DraftCommandOwner`) is shared by editor, chat and Work
surfaces, and outlives them:

- `hold(itemKeys, applying)` marks items in flight, which hides their rows.
- `presses` holds every press this tab can still take back (`PressEntries`,
  [state-machines.md](state-machines.md)).
- `notices` (`DraftNotices`) holds one notice per draft: the latest Discard with its Undo, or the
  latest Apply's facts, shown only on the surface it was made on. In the Changes list a notice is
  said on its rows (`useDraftNoticeWords`).

An Apply's Undo takes a created document out of Live too; if main shows it, main opens its plain
draft (`openDraftFile`). After a reload nothing offers a press's Undo.

**A chat card's Undo** is the server's `reverse_turn` command: it takes back its own reply's
changes.

## Not covered yet

- The draft switcher's drafts, New draft, Delete draft, and a Draft chat's turn cards (2d).
- The target picker offers Live only.
- A press Undo's changes it left (`PressUndoResult.stayed`) get no mark yet; Ctrl+Z's do
  (`showKept`). Changes to comment bodies are not reviewed.
