# features/draft-review — the writer's changes under review

The pieces every surface shows a review's changes with: the change list's rows,
the focused change's bar, the stepper, the draft switcher, the toast. One change
is one server closure class.

## Mental model

- **`reviewChanges(operations, hunks)`** is the one view-model: the preview's
  operations grouped by `closureClassId`, in document order (by the earliest
  hunk each owns; the server's operations are not in reading order), each with
  its colour (`tone`), whether the writer's edits are inside it, whether it is a
  merge nobody can split by author, and who made it (`change-attribution`).
- **`useReviewChanges(controller)`** reads the preview (`useDraftPreview`) and
  the change command records and returns the changes, the focused one, and
  `focus`, `step`, `apply`, `discard`. It takes the controller as an argument:
  the review lives in the **Editor** scope and the dock sits in the Chat's, so a
  surface outside the Editor passes `useEditorDraftReview().controller`.
- **Optimistic by record.** A change with an Apply or Discard in flight, or
  confirmed, is already gone from the preview these read
  (`client/query/change-command-record`). A failure brings it back with its
  reason, shown on its bar and row. A read that started before a confirmation
  cannot bring a change back. One command in flight disables every command
  (`controller.dispositionLocked`), so each is sent once.
- **Presentational components take no controller.** `ReviewChangeRow`,
  `ReviewChangeBar`, `ReviewStepper`, `DraftSwitcher` and `ReviewToast` are
  handed props and callbacks, so the phone's change sheet and bar reuse them.

## Key rules

- Apply and Discard send **every operation of the change**, never one
  representative. Apply also sends the live and draft revision tokens of the
  preview the writer saw; a `stale` answer refetches and keeps focus on the
  updated change (matched by shared operations, since the class id can change).
- There is no per-change Undo. The toast says what happened and nothing more.
- Per-change Apply is hidden for a new document (`isNewDocument`); it is applied
  whole with Apply draft.
- The chat link reads `actorThreadId` and `actorThreadTitle` from an operation;
  until the preview carries them every AI change reads "AI".
- The last change handled holds the review open (`cleared`) with "No changes
  left" and a Next draft button; it never jumps on its own. The draft is marked
  cleared (`markDraftCleared`) so it is not offered again while the server still
  lists it, emptied.
