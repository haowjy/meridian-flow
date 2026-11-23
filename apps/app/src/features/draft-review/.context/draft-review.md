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
  controls stay whole: the target picker (`against Live ▾`), the layout toggle, against Live the
  chapter's `Discard` · `Apply` (named "this chapter" for assistive tech), the stepper and Close. A pane under 720px offers Inline only and an icon
  Close; a line too narrow gives up in steps (`fitReviewLine`,
  [the identity bar](../../project/context/.context/document-identity-bar.md)).
- **The rows** are the editor's: `ReviewChangesExtension` (`core/editor/extensions/review-changes`)
  reads `changedBlocks` of the fork against Live 150 ms after typing pauses, or after Live's copy
  imports (a press, Live typed in elsewhere), and maps its decorations through the typing in
  between. Every group `changedBlocks` lists is a row (`reviewRows`), so the steps agree with the
  list's `changeCount`. Each changed block shows on itself, whatever it holds: a rule or an image
  added is ringed in the added tint, one removed shows Live's (a rule as a rule, an image by its
  caption); a container whose own blocks show the change (a list added with its items) adds
  nothing. A change that left the text alone says what changed in place of the old text, in one
  word at every size (`Moved`, `Style` for attributes or marks), and a comment body's change shows
  `Comment` and the two bodies on the paragraph the comment is on, across both columns Side by
  side. A row is
  named by one of its members, which a press takes; a link may name any member (`members`). It publishes the rows to the host's `ReviewSurface` for the review line and "Review N changes". The layout
  (Inline or Side by side) is a device preference, not in the address; Side by side gives every
  row both columns, an empty cell where one side has nothing.
- **A row's pair** presses that change (`startChange`, scope `change`). The row hides at once, the
  focus moves to the next row.
- **Against another draft or file** (`ReviewTargetPicker`, `useReviewReference`): the page holds
  the other room open for as long as it compares (another draft's fork of this document; the other
  file as this draft shows it) and reads rows of one paragraph each: aligned by block id against a
  draft (`draftDifferenceRows`), by the longest common run of equal paragraphs against a file
  (`fileDifferenceRows`). Against a draft each row offers `Take` (`takeRow`), an edit in this
  editor that Ctrl+Z takes back, after which the focus moves on as after a press. A paragraph only
  the other draft has comes in under `takenBlockId(source, draft)`: an id Live and the other draft
  never hold, so applying both drafts can't merge two texts into one paragraph, and the same on
  every Take, so the copy pairs with its source. That provenance, not equal text, is what clears
  the row, keeps a second Take from adding another copy, and shows an edited copy as an edit of
  its source. Against a file there are no actions. No press, so nothing closes the review and the
  stepper stays in this chapter. A target that is gone (a deleted draft, a file no longer in the
  project) compares against Live.
- **A margin widget is keyed on everything it draws** (`drawnKey`: the target, the reference's
  text, the words marked, the actions and their labels). ProseMirror reuses a widget whose key
  holds still, click handlers included: a key that missed the target once left Live's × / ✓ on a
  row against another draft, and its ✓ pressed Live.
- **Every press is a Ctrl+Z step** in each editor open on its documents, pushed as it is made in
  `usePressCommands.run`, the one path every press takes (margin, bar, tree row, Changes rows):
  `EditorPressStep`. Its Undo waits for the press's answer, then sends the press's Undo; Redo
  presses again. An Undo from the sidebar or a notice ends the press (`PressEntries`), which
  takes the editor's step away too; one Ctrl+Z took back stays for Redo.
- **Pressing the last change closes the review** at once. A read that comes back empty closes
  it only once the draft's list agrees (`ReviewMode.listed`): a fork still syncing reads empty
  before the list does.
- **The stepper crosses chapters** against Live: past either end it opens the next or previous
  chapter with changes, ‹ at its last change (`landOnLast`, held per pane by document until the
  chapter's address names a change: its review opens in a new host, and reads again before the
  focus lands). It counts the whole draft: this chapter's rows as read here, every other chapter's
  `DraftItem.changeCount`, and stays usable while this chapter has none left and others do.
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

**An Undo that leaves some of a press in place** (`PressUndoResult.stayed`: someone wrote over
it since) keeps those rows, in Review changes and the Changes list, marked `Kept` with who wrote
over it (`stayed-words.ts`), and the editor shows the same quiet mark Ctrl+Z's do
(`DocumentHistory.showStayed`).

## A Work's drafts

A Work holds several drafts; a chat writes into its thread's (`Thread.draftId`). Both version
chips, the sidebar's and a document's, draw them from `useWorkDraftMenu` (`work-draft-menu.tsx`),
and name the draft on screen the same way when there are several: `+ New draft` and `Delete
draft`, each a command of `client/query/draft-commands.ts` laid over the server's list until a read
has it. The draft the shell shows is remembered per tab (`useShownWorkDraft`); Delete goes back to
Live, and its notice is the project's delete notice (`deleteNoticeKey`) on main's document or
Recently opened, whose Undo changes nothing on screen. With several drafts the Changes list has a
heading per draft and its `Discard all` · `Apply all` presses the Work. The tab reads every draft's
list itself (`useDraftLists`, `useDraftsTreeChanges`) and its sections only draw, so Apply all
takes exactly the rows on screen. The chat's draft dock lists its own draft's files with the same
rows (`DraftFileRow`), presses that draft, and counts what the Work's other drafts change.

A chat in Draft mode whose Work has several drafts has a `Writes into` control in its composer
toolbar (`ChatDraftControl`), which points its lineage at another draft (`chat_draft`, laid over
the thread list by `projectChatDrafts` until a read has it). Its panel lists the drafts with the
version chip's rows (`WorkDraftRows`, `workDraftVersions`), `+ New draft` included, which makes a
draft and points the chat at it; `chat_draft` goes in the Work's draft lane too, so the server has
the draft first. A chat started while one of the Work's drafts is showing writes into that draft.

## Account command lifetime

`AccountFeatureLifetime.draftCommands` (`DraftCommandOwner`) is shared by editor, chat and Work
surfaces, and outlives them:

- `hold(itemKeys, applying)` marks items in flight, which hides their rows.
- `presses` holds every press this tab can still take back (`PressEntries`,
  [state-machines.md](state-machines.md)). Its Ctrl+Z step goes into each editor showing one of
  its documents in Live or in a draft of the press's scope that lists it (`editorsOf`), so two
  drafts on one chapter each get theirs.
- `notices` (`DraftNotices`) holds one notice per draft: the latest Discard with its Undo, or the
  latest Apply's facts, shown only on the surface it was made on. In the Changes list a notice is
  said on its rows (`useDraftNoticeWords`).

An Apply's Undo takes a created document out of Live too; if main shows it, main opens its plain
draft (`openDraftFile`). After a reload nothing offers a press's Undo.

**A chat card's Undo** is the server's `reverse_turn` command: it takes back its own reply's
changes. A Draft chat's card also offers `Restore before` in each draft the turn wrote, a press
with scope `turn` ([turn receipts](../../chat/.context/turn-edit-receipts.md)); its rows open
Review changes at the turn's first changed block.

## Not covered yet

- Nothing in the product writes a comment body yet, so a comment-only change reaches Review
  changes only through another client.
