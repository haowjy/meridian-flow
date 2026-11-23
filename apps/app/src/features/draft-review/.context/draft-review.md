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
  (`reviewOpenedFromMark`); **Close** and Esc go Back when that entry is the page's own, and
  otherwise replace. The stepper, a press and the target picker replace.
- **The rows** are the editor's: `ReviewChangesExtension` (`core/editor/extensions/review-changes`)
  reads `changedBlocks` of the fork against Live 150 ms after typing pauses and maps its
  decorations through the typing in between. It publishes the rows (`publishReviewRows`) for the
  bar's stepper. The layout (Inline or Side by side) is a device preference, not in the address.
- **A row's pair** presses that change (`startChange`, scope `change`). The row hides at once, the
  focus moves to the next row, and the press is one step in the fork session's `UndoHistory`
  (`pushOutsideStep`): Ctrl+Z sends the press's Undo, under the same rule as an edit.
- **An empty read closes the review** only once the draft's list agrees (`ReviewMode.listed`): a
  fork still syncing reads empty before the list does.
- **A plain draft** shows "Review N changes" (`ReviewChangesButton`), counted by the same extension
  in count mode, which paints nothing.

The tree half of a reviewed document is its row in the pane (`ReviewTreeRow`): Deleted, New, or
"Was <path>", with the document's pair while reviewing against Live.

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

- The server's press over `PressRequest` scopes (lane 2b): until it lands, a press 400s and its
  row comes back.
- The Changes list's pending flag for fork changes (2b), the draft switcher's drafts, New draft,
  Delete draft, and a Draft chat's turn cards (2d).
- The target picker offers Live only; the stepper counts only this chapter's changes.
- A stayed edit's mark naming who wrote over it, and changes to comment bodies.
