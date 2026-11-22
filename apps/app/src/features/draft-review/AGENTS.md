# features/draft-review — review of a Work's draft

Phase 1 of the move to Loro has no text drafts: a Work's draft is its tree records (creates,
renames, moves, deletes), and every text write lands Live. Text drafts come back in phase 2 as fork
rooms. Review lists the owner's draft items (`useOwnerDrafts`) and acts on them with a press
(`usePressCommands`): one server command over the items' tree changes, with one Undo (`unpress`).

- A press's items are in flight (`DraftCommandOwner.hold`) until the list is read again: a pressed
  row leaves the list and comes back if the press fails. Items never end on their own.
- A press (Apply or Discard) sits on the sidebar's Undo stack
  (`PressEntries`); Ctrl+Z there, a row's Undo or its notice's Undo takes it back once, and Redo
  presses the same items again.
- A tree line's row presses its tree change alone (`half: "tree"`).
- A Discard is not in Trash: its Undo is the press's, as Apply's is, and a reload ends the offer.
- A press that fails (Apply, Undo, Redo, Discard) is a brief pill (`notifyFailure`),
  never a line in the row or bar the writer pressed.
- Unknown authorship isn't known-empty: show the text without a byline.

Read [the runtime reference](.context/draft-review.md) before changing ownership.
