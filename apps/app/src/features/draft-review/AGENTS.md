# features/draft-review — the writer's changes under review

The pieces every surface shows a review's changes with: the change list's rows,
the focused change's bar, the stepper, the draft switcher, the toast. One change
is one server closure class.

## Mental model

- **`reviewChanges(operations, hunks)`** is the one view-model: the preview's
  operations grouped by `closureClassId`, in document order (by the earliest
  hunk each owns; the server's operations are not in reading order), each with
  its colour (`tone`), whether the writer's edits are inside it, whether it is a
  merge the server flags (`mergeArtifact` on a hunk), and who made it (`change-attribution`).
- **`useReviewChanges(controller)`** reads the preview (`useDraftPreview`) and
  the change command records and returns the changes, the focused one, and
  `focus`, `step`, `apply`, `discard`. It takes the controller as an argument:
  the review lives in the **Editor** scope and the dock sits in the Chat's, so a
  surface outside the Editor passes `useEditorDraftReview().controller`.
- **Optimistic by record.** A change with an Apply or Discard in flight, or
  confirmed, is already gone from the preview these read
  (`client/query/change-command-record`). A failure brings it back with its
  reason, shown on its bar and row. A read that started before a confirmation
  cannot bring a change back.
- **One command authority per draft.** `draft-command-record` holds the one
  claim per draft (project, Work, document, draft): a whole-draft Apply or
  Discard, or a per-change one with its operation set. It is reserved
  synchronously before anything is sent, so a second command for the same
  draft is refused whichever surface or session (Editor, Chat) sends it, and
  every surface's busy state (`controller.isDisposing`,
  `dispositionLocked`) is read from it. The change record never keeps its own
  pending state: a change's pending is the draft's claim. Never add a
  surface-specific guard or lock beside it.
- **`useReviewHeader`** is the header's model without its layout: the Work's
  drafts and their counts, the whole-draft commands that move on to the next
  draft, the refusal line and "No changes left". The desktop header
  (`features/editor/DraftReviewHeader`) and the phone's
  (`features/project/mobile/MobileReviewHeader`) are two layouts over it.
- **Presentational components take no controller.** `ReviewChangeRow`,
  `ReviewChangeBar`, `ReviewStepper`, `DraftSwitcher` and `ReviewToast` are
  handed props and callbacks, so the phone's change sheet and bar reuse them.
  `touch` is their phone form (44px targets); `DraftSwitcher` takes
  `draftCommands` and `marks` to carry what the phone header has no room for.

## Key rules

- Apply and Discard send **every operation of the change**, never one
  representative. Apply also sends the live and draft revision tokens of the
  preview the writer saw; a `stale` answer refetches and keeps focus on the
  updated change (matched by shared operations, since the class id can change).
- There is no per-change Undo. The toast says what happened and nothing more.
- Per-change Apply is hidden for a new document (`isNewDocument`); it is applied
  whole with Apply draft.
- The chat link reads `actorThreadId` and `actorThreadTitle` from an operation
  and names the chat as the chat list does (`displayThreadTitle`: "New chat"
  when untitled); an operation the server cannot place in a chat reads "AI".
- A change's excerpt reads its text once: operations of one change that report
  the same or overlapping text (the writer's edit inside an AI insert repeats it)
  are joined without the repeats.
- **Completion is one explicit state** (`inlineReview.completion`), set from the
  last change's command, never from how many changes are left on screen.
  `pending` (with the mode and the document's name): the command is in flight,
  its outcome unknown. The change is already gone from the list (optimistic),
  but header and dock say "Applying" or "Discarding", not "No changes left", and
  offer no way on. `closed`: the server's `draftClosed: true` answer. The review
  holds on "No changes left" with a Next draft button (or Back to live when no
  draft is left) and never jumps on its own. A success with `draftClosed: false`
  (another change arrived) withdraws `pending` and the review carries on. The
  draft leaves the Work's list when closed, so the hold is the review's own
  state, set from the answer before the list and preview re-reads; neither the
  provider nor the address owner exits a closed review because its draft left
  the list. The client keeps no list of "cleared" drafts. `useReviewChanges`
  derives `completing` and `finished` once (header and dock both read them);
  an empty optimistic list with a command still hiding a change is not finished.
- The editor follows it. A last Discard shows the warm live editor at the click
  (live already is the finished text, and the review room's reset would show
  doubled text), but inert until `closed`, and the review comes back if the draft
  stays open. A last Apply keeps the review editor, marks gone, until the answer
  (live has no change in it before).
- Unknown outcomes are held, not guessed. A per-change Apply that got no answer
  is held on its change as `unknown` ("Couldn't confirm whether this applied"),
  the whole-draft Apply's wording, apart from a refusal (`offline`). A rejected
  whole-draft Apply is held on that draft's record (`apply-failed`) and shown
  wherever the draft is listed (switcher row, composer strip, Work files, Changes
  tab) after the review moved on to the next draft; it never navigates back.
