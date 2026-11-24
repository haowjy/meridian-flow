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
- **The controls** (`ReviewBar`) take the formatting toolbar's place in its row while the page
  reviews (`DocumentToolbarPortal`; the shortcuts still work), so the page has one bar: the target
  picker (`against Live ▾`), the layout toggle, then the stepper and, against Live, the chapter's
  × and ✓ (icons, named "this chapter"). Close is `ReviewChangesButton` in Review changes, in the
  very place `Review N changes` was, so the writer goes in and out without moving the pointer. A
  pane under 680px offers Inline only (one side panel open beside a 1280px window fits Side by
  side, both open does not); nothing closes a panel for it. A line too narrow gives up in steps
  (`fitReviewLine`, `review-line.css`): the short count, no count, then (a finger only) no
  stepper. The phone's review row is the same bar with its own Close.
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
  named by one of its members, which a press takes; a link may name any member (`members`). It publishes the rows to the host's `ReviewSurface` for the review bar and "Review N changes". The layout
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
"Was <path>". The chapter's pair is on the review bar.

## Presses

An Apply or Discard is a press (`usePressCommands`, `client/query/press-commands.ts`) with a scope:
one change, one document, the draft, or the Work. It is sent through the command driver, which
resends it under the same id until the server answers. Before each send the driver waits on
`ready`: the server holds what this browser's copies of the press's rooms had
(`registry.whenSentAcknowledged`), so the server presses what the writer saw. A press holds one
lane per draft it presses (`press:<draft>`, from `pressDrafts`): a Work's press names in its body
the drafts the Changes list showed, the server presses exactly those, and it holds their lanes, so
it goes after an Apply or Discard pressed earlier on any of them; its Undo holds the same lanes.
A press of another draft that never lands (the driver retrying a 5xx) therefore holds back a
Work's press that names that draft too. The rooms come from those lanes, with no read of the
server: each draft's forks (only the named document's for a change or document) and their Live
rooms. A copy with unsent words that the tab has no session for (after a reload) is opened so its
Join sends them. A stuck room of another draft does not hold the press.

A press body is version 3. An unsent version 1 press migrates to a scope where one says the same.
An unsent version 2 Work press named no drafts and held a `press:work:<id>` lane; the drafts its
tab listed are not known offline, so it settles `never`: "Couldn't apply", and its rows come back.

The Changes list, the chat strip and a page read the owner's draft list (`useOwnerDrafts`). It is
re-read when the server wakes the owner (`useProjectWake`) and in each of the account's tabs when a
press or its Undo settles (`refreshDraftReads`). A pressed row leaves while the press is in flight
and comes back with a pill if the press fails. The journal is the one holder of what is in flight,
in every tab and through a reload: a press not yet answered, or answered and not yet `observed`
(`followPresses`, fed by `FollowPresses` in `routes/_authenticated.tsx`). A press is observed once
every draft list on screen in that tab has been read from the server since it settled
(`whenDraftListsRead`): a read that failed keeps the rows held until one succeeds. The pressing
tab also takes whole rows out of its cached list in the frame it presses, before the journal
commits, so neither that gap nor a read already out shows them. The Work's review count leaves
out what the journal holds (`changeCount`, `pressedDrafts` in `tree-version.tsx`), so its badges
agree with the list. The follower also shows the "Couldn't apply" pill, once, for a press settled
`never` since the tab opened, in a tab showing that press's project, so a press that fails after a
reload still says so.

In the Changes tab a draft's notice speaks only on its own section's rows: two drafts can hold one
chapter, and applying one draft's leaves the other's row pending, without the first one's Undo. A
Work's notice (`workNoticeKey`) speaks on every section.

A press's Undo always runs, whatever was written since (design §2): every row it pressed comes
back pending.

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

- `followPresses` holds the items of the journal's presses in flight, which hides their rows.
- `presses` holds every press this tab can still take back (`PressEntries`,
  [state-machines.md](state-machines.md)). Its Ctrl+Z step goes into each editor showing one of
  its documents in Live or in a draft of the press's scope that lists it (`editorsOf`), so two
  drafts on one chapter each get theirs.
- `notices` (`DraftNotices`) holds one notice per draft: the latest Discard with its Undo, or the
  latest Apply's facts, shown only on the surface it was made on. In the Changes list a notice is
  said on its rows (`useDraftNoticeWords`). A page has no rows: an Apply or Discard made on a
  document's page, per paragraph or the whole chapter, is a compact `ActionNotice` with Undo
  floating at that page's foot (`PageNotice`, `DraftNotices.forDocument`), so it never moves the
  toolbar or the prose. It belongs to the draft the page showed: once no host shows that document
  on that draft (switching to another draft, to Live or to another document), it ends silently,
  and coming back doesn't bring it back. Each host registers the page it shows
  (`DraftNotices.showPage`, from `useDocumentReview`), so a side panel opening or the chapter
  moving to the other pane keeps the notice; it never ends from a component's unmount.

An Apply's Undo takes a created document out of Live too; if main shows it, main opens its plain
draft (`openDraftFile`). After a reload nothing offers a press's Undo.

**A chat card's Undo** is the server's `reverse_turn` command: it takes back its own reply's
changes outside a draft. What a Draft chat's reply did in a draft is the turn's restore instead,
labelled `Undo turn`, one per draft the turn wrote, a press with scope `turn` ([turn receipts](../../chat/.context/turn-edit-receipts.md)); its rows open
Review changes at the turn's first changed block.

## Not covered yet

- Nothing in the product writes a comment body yet, so a comment-only change reaches Review
  changes only through another client.
