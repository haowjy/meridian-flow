# features/draft-review — the writer's changes under review

The pieces every surface shows a review's changes with: the change list's rows,
the focused change's bar, the stepper, the Draft chip and its menu, the document's change list, the toast. One change
is one server closure class. The feature also owns the review's state and commands:
`DraftReviewProvider` (the scope owner), `useDraftReviewController` and
`draft-review-session` (the command session), `ReviewMessageText` (refusal and
failure copy) and `review-files` (the file model: `ReviewFileTarget`, the one file
order `sortDraftFiles`, `nextReviewFile`). Chat, the editor and the project shell
consume them; none of it is chat rendering. Lifecycle contracts:
[`.context/draft-review.md`](.context/draft-review.md).

## Mental model

- **`reviewChanges(operations, hunks)`** is the one view-model: the preview's
  operations grouped by `closureClassId`, in document order (by the earliest
  hunk each owns; the server's operations are not in reading order), each with
  its colour (`tone`), whether the writer's edits are inside it, whether it is a
  merge the server flags (`mergeArtifact` on a hunk), and who made it (`change-attribution`: every chat with a visible
  operation in the class, latest first, and `threadIds` for the chat strip).
- **The focus is the review's, not a reader's.** `controller.focus` holds the
  focused change's class id and the operations it held (`inlineReview.focus`);
  `useReconcileReviewFocus`, mounted once by the scope owner, moves it onto the
  regrouped change when the server changes a class id, and every reader resolves
  it with the pure `resolveFocusedChange`. A reader keeps no focus history, so a
  surface mounted after a regrouping agrees with one already showing it.
  `focusReviewChange(review, change)` names the review it was meant for and is
  ignored when another is open. The change list is derived once per preview
  (`reviewChangesOfPreview`) and shared by every reader.
- **One refresh owner.** `useReviewRefresh` (scope owner) watches the review room
  and the live document and re-reads the draft list and the preview once per
  settled burst; the manuscript's `useInlineReviewSync` only projects the result.
  Any other mounted preview target is refreshed by `useDraftPreviews` itself, when
  its draft's list row (`updatedAt`) changes: it invalidates that one preview key
  and joins no room.
- **`useReviewChanges(controller)`** reads the preview (`useDraftPreview`) and
  the change command records and returns the changes, the focused one, and
  `focus`, `step`, `apply`, `discard`. It takes the controller as an argument:
  the review lives in the **Editor** scope and the Work page and the chat's strip sit in other scopes, so a
  surface outside the Editor passes `useEditorDraftReview().controller`.
- **Any draft's change list, any draft's selection commands.**
  `DocumentChangeRows` renders a `DraftChangesView` (`draft-changes`): the open
  review's is `useReviewChanges`, any other draft's is `useDraftChanges(target,
  { controller })` (preview via `useDraftPreviews`, no focus, no completion, never
  joins a review room; for the Editor's open review it reads the Editor's model).
  A command acts on a `ChangeSelection` (`{ classIds, operationIds }`; one change
  is a selection of one class) of any draft of the controller's Work
  (`controller.applyChanges(draft, selection)`). The command's coverage of the
  draft's last changes and the server's `draftClosed` answer live in the draft's
  claim (`draft-command-record`), and whichever review has the draft open follows
  them (`useReviewCommandCompletion`; a review that opens mid-command adopts the
  pending completion), whoever sent it. Nothing of the answer outlives the claim:
  the server reuses a closed draft's id for its next proposal. Surfaces send through
  `useChangeCommandRunner(callerController)`, which routes a draft that is the
  Editor's open review (in the caller's project and Work) to the Editor's
  controller and any other to the caller's, and runs a batch as one command per
  draft (every draft gets its turn, in the Work the batch began in). That is not `disposeDrafts`, the whole-draft Apply all and
  Discard all with their batch lifecycle.
- **A refusal's words are chosen when shown.** A typed refusal is stored as the
  server's code and text (`serverCode`, `serverReason`); `RefusalReason` words the
  known codes in the language shown at that moment, and keeps the server's text
  for any other code. One failure is held per (draft, selection); it is found by one
  overlap-aware rule (a shared class id or operation, newest wins) for showing it
  on each overlapping change and on the file that sent the selection, and for
  retiring it.
- **Optimistic by record.** A change with an Apply or Discard queued in a
  batch, in flight, or confirmed, is already gone from the preview these read
  (`client/query/change-command-record`). A failure brings it back with its
  reason, shown on its bar and row. A read that started before a confirmation
  cannot bring a change back. No surface keeps an optimistic hide of its own (a
  strip-local one held a refused file hidden until its whole batch ended).
- **One command authority per draft.** `draft-command-record` holds the one
  claim per draft (project, Work, document, draft): a whole-draft Apply or
  Discard, or a per-change one with its operation set. It is reserved
  synchronously before anything is sent, so a second command for the same
  draft is refused whichever surface or session (Editor, Chat) sends it, and
  every surface's busy state (`controller.isDisposing`,
  `dispositionLocked`) is read from it. The change record never keeps its own
  pending state: a change's pending is the draft's claim. Never add a
  surface-specific guard or lock beside it.
- **There is no review header row on the desktop.** The review's controls live in
  the document's identity row (`DocumentIdentityBar`): the Draft chip with its
  menu after the breadcrumb, then the list button, the stepper, Show changes,
  Discard and Apply
  on the right (`features/editor/DraftReviewBand`, sized to the row's 22px
  box, so entering review moves nothing below it). The state lines of the
  review ("No changes left" with Next draft, "Applying", "Formatting changes
  remain") are an inline run in that row (`ReviewStateInline`); refusals need a
  line of their own and sit under the row (`DraftReviewFailureNotices`, only
  while there is one). Narrow rows collapse in a fixed order, always on one row:
  folders become `…`, Show changes becomes an icon (same name), `4 of 4`
  becomes `4/4`, the scheme's name becomes its icon, then the file name
  truncates. The Draft chip, the list button, Discard and Apply never hide in a
  narrow row.
- **`useReviewHeader`** is the header's model without its layout: the next draft
  file, the whole-draft commands that move on to it, the refusal line and "No
  changes left". The identity row's band and the phone's header
  (`features/project/mobile/MobileReviewHeader`) are two layouts over it.
- **The version chip (`DraftChip`) is one control with one menu.** "Live" on a
  live document with a pending draft (`DraftReviewChip`: the identity row on the
  desktop, a row under the top bar on the phone) and "Draft" while reviewing;
  both open the same `DraftSwitcher` menu with the showing version checked.
  Under review the identity row takes the reviewing tab's tint (`dock-surface`),
  so tab and row read as one draft surface. Its menu is the versions of THIS
  document: the live version and its draft (a document has one active draft
  per Work today, so those are the two; listing drafts of one document across
  Works needs an endpoint the server does not have). The desktop offers Rename;
  the phone adds Apply draft, Discard draft and Show/Hide changes. A new document
  offers Close review instead of Live version. It names no other file.
- **Three scopes, three surfaces; one file order.** Each list of changes is 1:1
  with the thing it sits on. This chat's changes are the composer strip. This
  document's are `DocumentChanges` (`DocumentChangeRows` plus the open review's
  state lines), in the identity row's list popover on the desktop
  (`DraftReviewBand`, a button present in every review state) and in the phone's
  change sheet, each ending in `WorkChangesLink` ("All changes in <Work>", one
  transition to the Work's Files tab, nothing in No Work). This Work's are the Work
  page's Changes to review (`features/project/work/WorkChanges`): every draft file
  once, a row expanding in place to its changes, with Apply all and Discard all
  (whole drafts, `disposeDrafts`) in its menu. Every list of draft files uses
  `sortDraftFiles` (name, then id; never update time, which reshuffles as the AI
  writes), and a change list keeps document order (`reviewChanges` breaks ties on
  class id so a refreshed preview never reorders them). Moving between files on the
  desktop is the Work page or Next draft; the dock keeps no draft state.
- **Presentational components take no controller.** `ReviewChangeRow`,
  `ReviewChangeBar`, `ReviewStepper`, `DraftSwitcher` and `ReviewToast` are handed
  props and callbacks, so the phone's change sheet and bar reuse them. `touch` is their phone form (44px targets); `DraftSwitcher`
  takes `draftCommands` and `marks` to carry what the phone header has no room for.
  The row's excerpt keeps a floor width (`flex-[1_1_8rem]` in a wrapping line), so
  `ChangeAuthor` drops under it when several chats' names do not fit beside it;
  `ChangeAuthor` sets no width cap, each caller bounds it.

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
  Apply draft, Discard draft, Next draft and Open on a refused draft all go through
  `openEditorReview`, which hands the page's painted review (header, identity bar, body) to
  `ReviewHandoverFrame` as inert markup, the way `FrozenReview` holds a review across a room
  rebuild. The route, tab and URL change at the click. One hold has one owner (the handoff
  provider's `useReviewHandoverOwner`) and is keyed to the review it waits for (`target`); the
  markup is only what stands in for it:
  - **Input.** The real page under the copy is inert for the whole hold (an `inert` wrapper
    inside the frame, with an "Opening ..." status line outside it; focus that was in the page
    moves to the status line and returns to the frame when the hold ends). The copy being
    inert is not enough. Tabs, sidebar and the rest of the shell are outside the frame and stay
    usable.
  - **End.** The target paints (`inlineReview.shown`, released in that commit so the swap is
    one frame), its review room fails (`reviewRoomError`), its review was entered and left, the
    route goes anywhere but where the move started or the target (`useReviewHandoverRelease`,
    mounted in the address owner, which is mounted whatever page is), the launch fails or is
    cancelled, or the absolute expiry passes (10 s from the first capture, set in the owner; a
    second move keeps it, and no page's mount or unmount can extend it).
  It captures only a painted review (`shown`), and a move that follows a move keeps the first
  copy. Wrap any new page that hosts a review in `ReviewHandoverFrame`. The next draft's
  preview is prefetched (`useReviewHeader`) while the writer is still in this one; the review
  room is still discovered with a fresh read, because a draft's room can change when it is
  disposed.
- **Writer typing has draft-only client boundaries** (`core/editor/extensions/inline-review/writer-client`).
  The next content edit rotates the Yjs client when it touches a different
  server closure class or a disjoint untouched site. Edits in one class and
  contiguous typing keep their client. A pause or caret move alone never
  rotates. Relative anchors classify edits even with marks hidden. Awareness
  migrates with the client without remounting the editor or resetting Undo.
  Genuine structural dependencies still join changes. Undo/Redo capture source-ID
  restoration claims in a separate Y.Map, alongside the physical writer copies.
  Only server-certified journal aliases preserve the source author in preview
  and Apply; ordinary retyping stays the writer’s. Claims survive offline sync
  and reload through normal Yjs persistence, not a browser-only colour overlay.
- There is no per-change Undo. The toast says what happened and nothing more.
- Per-change Apply is hidden for a new document (`isNewDocument`); it is applied
  whole with Apply draft.
- The chat links read `actorThreadId` and `actorThreadTitle` from the visible
  operations of a change and name each chat as the chat list does
  (`displayThreadTitle`: "New chat" when untitled); an operation the server
  cannot place in a chat reads "AI". A change several chats wrote names all of
  them, latest first ("Pacing pass and Lore pass"), each its own link. A link
  opens its chat beside the change where that chat's latest write happened: it
  asks for a turn reveal carrying that operation's `actorTurnId` and
  `actorToolCallId` (the chat's `conversation-reveal` turn stage). Without a
  recorded turn it only opens the chat.
- A change's excerpt reads its text once: operations of one change that report
  the same or overlapping text (the writer's edit inside an AI insert repeats it)
  are joined without the repeats.
- **Completion is one explicit state** (`inlineReview.completion`), set from the
  last change's command, never from how many changes are left on screen.
  `pending` (with the mode and the document's name): the command is in flight,
  its outcome unknown. The change is already gone from the list (optimistic),
  but the header and the change list say "Applying" or "Discarding", not "No changes left", and
  offer no way on. `closed`: the server's `draftClosed: true` answer. "Last
  change" is predicted from what **remains**: unclassified hunks and
  non-actionable classes count (`reviewChanges` lists them), so a last classified
  change beside an unclassified hunk predicts nothing. The review
  holds on "No changes left" with a Next draft button (or Back to live when no
  draft is left) and never jumps on its own, except to the same draft's next
  proposal: the server reuses the id, and `useFinishedReviewReentry` re-enters the
  review once a read made after the close lists changes. A success with `draftClosed: false`
  (another change arrived) withdraws `pending` and the review carries on. The
  draft leaves the Work's list when closed, so the hold is the review's own
  state, set from the answer before the list and preview re-reads; neither the
  provider nor the address owner exits a closed review because its draft left
  the list. The client keeps no list of "cleared" drafts. `useReviewChanges`
  derives `completing`, `finished` and `unlisted` once (the header and the lists all read
  them). `finished` is `completion.phase === "closed"` and nothing else: an empty
  list never means finished. `unlisted` is a draft that is still open whose read
  lists no change and no command hides one (formatting the server does not
  represent): the header and the change list say "Formatting changes remain", with Apply
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
  draft (`apply-offline`, `discard-offline`). Apply draft and Discard draft
  move to the next draft only when the command is sent: an offline click
  keeps the writer on the draft, where its refusal shows. TanStack's
  default would pause the mutation and fire it on reconnect with the change
  gone from the screen meanwhile. Nothing fires when the network returns; the
  writer acts again.
- **A failure's wording comes from what the request was, never from its message**
  (`client/query/draft-command-rejection`). No HTTP answer (offline, dropped):
  `offline`, the only one that says "Check your connection". A typed server
  envelope (`MeridianApiError`): `refused`, "Couldn't apply this change." (or
  "...this draft.", "Couldn't discard...") followed by the server's own reason
  when it sent one. An HTTP error with no envelope (a bare 5xx): `server-error`,
  "...Try again." with no mention of the connection. The client words no reason
  itself, so it assumes no Work. `stale` is unchanged.
- Unknown outcomes are held, not guessed. A per-change Apply or Discard that got
  no answer is held on its change as `unknown` ("Couldn't confirm whether this
  applied." / "...was discarded. Check what is left before you try again."),
  apart from a refusal (`offline`); both run through one flow in the session. A
  whole-draft Discard has no unknown outcome: a lost answer is `discard-offline`. The copy promises no automatic update: only
  a read after the failure can resolve the change, and one can find it still there. A rejected
  whole-draft Apply is held on that draft's record (`apply-offline`, `apply-refused`, `apply-server-error`) and shown
  wherever the draft is listed (the strip of each chat that wrote it, the Work
  page's Changes to review) after the review moved on to the next draft; it never navigates back.
  The review the writer is in also says it: `useReviewHeader.failedElsewhere`
  lists the Work's other drafts that hold a refusal or lost answer, and
  `ReviewHeaderNotices` shows each by name with an Open button, on both shells
  (Apply draft moves on while the command runs, and Apply all runs from the
  Work page, away from the review). Opening the draft is the writer's
  move and keeps its failure (opening Review clears only a failed launch,
  `clearDraftReviewLaunchFailure`); it is then that draft's own header message
  until the writer acts on it again. **A batch (Apply all, Discard all) never stops at
  a refusal**: drafts are independent documents, so each gets its turn, each
  failure is held on its own draft.
  **A batch never navigates**: the writer stays where they are (nothing is
  decided from an answer, which can arrive after they went elsewhere), and Open
  on a refused draft's notice is the only way to it. The review the writer is in
  is part of the batch: `batchStarted` sets its completion to `pending` (the
  header says "Applying" or "Discarding", and every "the draft left the list"
  exit reads it as the writer's own), its own answer closes it (`reviewClosed`,
  "No changes left", the same state a last change leaves, so the refusal notices
  stay in front of the writer), and a batch that ends without closing it
  (refused, lost) withdraws the pending state. A new document's review is not
  held: it is promoted to the live document as before.
