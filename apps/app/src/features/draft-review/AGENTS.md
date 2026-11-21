# features/draft-review — review of a Work's suggestions

A Work's draft is its suggestion marks in the Live document (`packages/suggestions`). Review reads
them from the host's Live editor (`host-editor.ts`, `useSuggestionChanges`); there are no draft rooms.

- One change's Apply or Discard is an editor transaction (`acceptSuggestion` /
  `rejectSuggestion`), one Ctrl+Z entry. A document's, folder's, selection's or Work's is a press
  (`usePressCommands`): one server command over text and tree, with one Undo (`unpress`).
- A press's items are in flight (`DraftCommandOwner.hold`) until the list is read again: a pressed
  row leaves the list and comes back if the press fails. Items never end on their own.
- A press Apply sits in each open editor's history (`ApplyEntries`); Ctrl+Z there or a row's
  Undo takes it back, and Redo presses the same items again.
- A tree line's row presses its tree change alone (`half: "tree"`).
- A Discard deletes nothing and is not in Trash. Its notice's Undo and its sidebar step send one
  `unpress`, once (`undoOf` in `usePressCommands`); a reload ends the offer.
- A press that fails (Apply, Undo, Redo, Discard, Restore) is a brief pill (`notifyFailure`),
  never a line in the row or bar the writer pressed.
- Unknown authorship isn't known-empty: show the text without a byline.

Read [the runtime reference](.context/draft-review.md) before changing ownership.
