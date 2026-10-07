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
  representative. Both also send the live and draft revision tokens of the
  preview the writer saw; a `stale` answer (Apply or Discard) refetches, brings
  the change back with "This change was updated. Check it and apply (or
  discard) again.", and keeps focus on the updated change (matched by shared
  operations, since the class id can change). A refusal is never a closed or
  discarded draft: only a `discarded` or `applied` answer can carry `draftClosed`
  to the review. `incomplete_class` reads as `stale`; `gone` drops the change
  with a toast; `draft_only` points to Apply draft or Discard draft.
  Whole-draft Discard stays unfenced.
- **What the server could not attribute is still a change.** An unclassified
  hunk with no operation (`unclassified: true`, `operationIds: []`) is listed
  (`reviewChanges`) as its own change, in document order, with no author
  ("Unattributed", `attribution.kind === "unattributed"`, neutral tone) and
  **no per-change Apply or Discard**: its class id is the editor's stand-in key
  (`unattributedHunkKey`), which never reaches the server and no command takes
  (`ReviewChange.operationIds` is empty and the controller refuses a command with
  nothing to send). Every member of a class the server flags
  `canApplyOrDiscard: false` is likewise `actionable: false`: its row and bar
  keep the class's author but omit the buttons, and the bar says "Apply draft or
  Discard draft handles this." The editor paints such a hunk neutral (the merged
  seam for an insertion, the full `deletedText` struck in no author's colour for
  a removal). `markKeys` are the keys the manuscript paints a change by.
  `previewWithoutOperations` never hides a hunk no operation owns.
- **A move from one draft's review to another's is held** (`features/project/dock/review-handover`).
  Switcher pick, Apply draft, Discard draft, Next draft and Open on a refused draft all go through `openEditorReview`, which hands the
  page's painted review (header, identity bar, body) to `ReviewHandoverFrame` as
  inert markup, the way `FrozenReview` holds a review across a room rebuild. The
  route, tab and URL change at the click; the copy covers the skeleton the route
  settles through and is released in the commit that paints the target
  (`inlineReview.shown` for its document and draft), or on a failed or cancelled
  launch, or after 10 s. It captures only a painted review (`shown`), and a move
  that follows a move keeps the first copy. Wrap any new page that hosts a
  review in `ReviewHandoverFrame`. The next draft's preview is prefetched
  (`useReviewHeader`) while the writer is still in this one; the review room is
  still discovered with a fresh read, because a draft's room can change when it
  is disposed.
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
  offer no way on. `closed`: the server's `draftClosed: true` answer. "Last
  change" is predicted from what **remains**: unclassified hunks and
  non-actionable classes count (`reviewChanges` lists them), so a last classified
  change beside an unclassified hunk predicts nothing. The review
  holds on "No changes left" with a Next draft button (or Back to live when no
  draft is left) and never jumps on its own. A success with `draftClosed: false`
  (another change arrived) withdraws `pending` and the review carries on. The
  draft leaves the Work's list when closed, so the hold is the review's own
  state, set from the answer before the list and preview re-reads; neither the
  provider nor the address owner exits a closed review because its draft left
  the list. The client keeps no list of "cleared" drafts. `useReviewChanges`
  derives `completing`, `finished` and `unlisted` once (header and dock all read
  them). `finished` is `completion.phase === "closed"` and nothing else: an empty
  list never means finished. `unlisted` is a draft that is still open whose read
  lists no change and no command hides one (formatting the server does not
  represent): the header and dock say "Formatting changes remain", with Apply
  draft and Discard draft available and no Next draft.
- The editor follows it. A last Discard shows the warm live editor at the click
  (live already is the finished text, and the review room's reset would show
  doubled text), but inert until `closed`, and the review comes back if the draft
  stays open. A last Apply keeps the review editor, marks gone, until the answer
  (live has no change in it before).
- **Offline is a refusal of the click, never a queue.** The Apply and Discard
  mutations (`useDraftReviewMutations`) run with `networkMode: "always"` and
  refuse with `DraftCommandNotSentError` when `onlineManager` says the browser
  is offline: the change comes back as `offline` ("Couldn't apply/discard. Check
  your connection and try again.") and a whole-draft command is held on its
  draft (`apply-failed`, `discard-offline`), the same as a rejection. TanStack's
  default would pause the mutation and fire it on reconnect with the change
  gone from the screen meanwhile. Nothing fires when the network returns; the
  writer acts again.
- Unknown outcomes are held, not guessed. A per-change Apply or Discard that got
  no answer is held on its change as `unknown` ("Couldn't confirm whether this
  applied." / "...was discarded. Check what is left before you try again."),
  apart from a refusal (`offline`); both run through one flow in the session. A
  whole-draft Discard has no unknown outcome: a lost answer is `discard-offline`. The copy promises no automatic update: only
  a read after the failure can resolve the change, and one can find it still there. A rejected
  whole-draft Apply is held on that draft's record (`apply-failed`) and shown
  wherever the draft is listed (switcher row, composer strip, Work files, Changes
  tab) after the review moved on to the next draft; it never navigates back.
  The review the writer is in also says it: `useReviewHeader.failedElsewhere`
  lists the Work's other drafts that hold a refusal or lost answer, and
  `ReviewHeaderNotices` shows each by name with an Open button, on both shells
  (Apply draft and Apply all move on or finish while the command runs, and the
  switcher's row is behind a closed menu). Opening the draft is the writer's
  move and keeps its failure (opening Review clears only a failed launch,
  `clearDraftReviewLaunchFailure`); it is then that draft's own header message
  until the writer acts on it again. **A batch (Apply all, Discard all) never stops at
  a refusal**: drafts are independent documents, so each gets its turn, each
  failure is held on its own draft, and `dockDispositionError` names the kind.
  **A batch never navigates**: the writer stays where they are (nothing is
  decided from an answer, which can arrive after they went elsewhere), and Open
  on a refused draft's notice is the only way to it. While it runs, the header
  says "Applying" or "Discarding" (`controller.batchRunning`). When it closes the
  draft the writer is reviewing, that review holds on "No changes left" (the same
  `completion: closed` a last change leaves; a new document's draft is promoted
  instead), so the refusal notices stay in front of them.
