# features/draft-review — changes under review

Shared review state and presentation for the manuscript, document change list,
Work page and chat strip. A change is a group of the text diff between the
draft's `review_base` fragment and its `prosemirror` fragment, computed in the
browser; there is no server preview. Read [the reference][reference] before
changing state, Discard or Apply. This file maps ownership.

## Ownership map

| Concern | Owner |
|---|---|
| Presented-document review scope | `DraftReviewProvider.tsx`, composed by `ProjectView.tsx` |
| Presented document and per-container review address | `features/project/presented-document.ts`, `features/project/ReviewAddressOwner.tsx` |
| Selected review, focus (a change id), marks visibility | `draft-review-session.ts` reducer |
| View transitions, open-review publication, Apply/Discard routing | `useDraftReviewController.ts` |
| Review frame (`projectReview(diffBlocks(base, draft))`, snapshot, pins), applied-change identity | `review-frame.ts`, `review-model.ts` |
| Visible changes and their failures, derived once per room from the frame and command records | `review-visible.ts`, `review-runtime.ts` |
| Room-scoped review runtime: one frame stream per draft, editor or headless, record reconciliation | `review-runtime.ts`, `useReviewRuntime.ts` |
| Local Discard (one change, Discard draft) as one undo step | `draft-discard.ts` |
| Discard from a surface with no editor (strip, Work rows), Undo on the row | `room-discard.ts`, `useHeadlessDiscards.ts`, `DiscardedRow.tsx` |
| Chat attribution hint (which chats' edits overlap a change): fetched and matched once per room by the runtime | `review-runtime.ts`, `chat-changes.ts` |
| Apply snapshot, acknowledgement wait, unopened-draft read | `useDraftApply.ts` |
| Apply records (applied changes, failures, overrode, whole-item claim) | `client/query/draft-command-record.ts` |
| Apply lifecycle (claim, prepare, send, outcome) and item Discard | `client/query/draft-command-executor.ts` |
| Creation-bound Work command capability | `useWorkDraftCommands.tsx` |
| Draft metadata (base, branch room) | `client/query/useDraftMeta.ts` (`useDraftMeta`) |
| Room acquisition and eligibility | `useReviewRoomOwner.ts` |
| Review composition and paint readiness | `features/editor/EditorView.tsx`, `features/editor/useInlineReviewSync.ts` |
| Remote draft-only settlement | `DraftOnlySettlement.tsx` |
| Cross-container promotion/removal | `draft-only-lifecycle.ts` |
| Listed rows, catalog-labelled files, stable order | `client/query/work-draft-files.ts`, `useWorkDrafts.ts` |
| Change items for rows and strip | `draft-changes.ts`, `useOpenReviewChanges.ts` |
| Open-review and unopened-file interaction bindings | `useReviewChanges.ts`, `useDraftView.ts` |
| Shared focus reconciliation | `useReconcileReviewFocus.ts` |
| Layout-independent header model, notices, completion | `useReviewHeader.ts`, `ReviewHeaderNotices.tsx`, `ReviewCompletion.tsx` |
| Refusal/failure wording | `ReviewMessageText.tsx`, `ReviewChangeParts.tsx` |

Paths outside this directory are relative to `apps/app/src`.

## Load-bearing rules

- Review is a pure function of the text. Never store review state beside the
  document; a move, undo, cut or paste changes the text and the review follows.
- Discard of a change or of a document's draft is local, instant and one Ctrl+Z step:
  it writes the draft fragment under the editor's own undo origin and the server learns it
  as any edit. Off the editor, an expanded row edits the room it already holds
  (`useHeadlessDiscards.discardChange`, synchronous) and reads "Discarded" with Undo only after
  the edit exists. A chat-wide Discard on a collapsed file acquires its room first and reads
  "Discarding" with Cancel until then. `changeRows` is the one row state: an entry replaces
  its change's row, never sits beside it. Whole-item Applying/Discarding shows on the file
  (`FileCommandStatus`) from the command records, on the Work page and the strip alike. Item Discard (a new, binary or live-deleted
  document) and the Work page's Discard all close on the server.
- Every change row carries the frame it was listed from. Apply sends that frame's
  snapshot; Discard finds its pinned position and content hash again in the current text
  (`draft-discard.ts`). Never rebind a click to the runtime's newest frame.
- A clicked change is found again by its pinned position and content hash
  (`draft-discard.ts`). If the text under it changed, Discard is a no-op, never
  a guess at a neighbour.
- Apply (`apply-changes` for named changes, `apply` for an item) sends the snapshot of
  the projection the writer clicked, after the server holds every update it contains. `overrode` is a
  dismissible notice per draft, not a gate.
- An item with no changes left stays open and in its room; "No changes left" is derived from the projection.
  Its room is remounted only when the server returns a new room name.
- Only red and green: no writer, merged or restoring tones. Chat names are a
  best-effort hint on a change; nothing gates on them.
- Never add a surface-local command lock, optimistic hide or completion store;
  `draft-command-record.ts` owns them.
- Commands keep their creation-bound Work and thread invalidation authority.
  Offline clicks do not remove tabs or replay on reconnect.
- Room ownership is not editor paint ownership; the room survives leaving review. One room
  computes one frame, but each editor attachment (tab, dock) owns its painter and command
  handle (`editorHandle(editor | surface)`): a Discard is authored into the history of the editor the
  writer clicked in. A control outside the editor but belonging to its surface (the review band, the
  phone header) names that surface ("editor" or "dock"); only a row that sits in no editor (Work
  page, strip) takes the longest-attached one.
- A whole-item Apply from an open editor flushes that editor's projection at the click
  (`handle.projectNow()`) and sends that frame, so words typed inside the debounce apply. Per-change
  Apply and a headless file Apply keep the frame their row was drawn from.
- A held Discard owns its history and a lease on its room until Undo (`useHeadlessDiscards`),
  whether the row was expanded or collapsed. A row is drawn only from a room its reader holds.
- An Apply whose change a peer removed while it waited keeps its Applying and its failure on
  the file (`reconcileChangeRecords`), never on a surviving twin and never as a row.
- Every rendered Apply (per change, open new document, whole item) carries the frame its
  button was drawn from.
- Focus readers are pure. Reconcile once per scope.
- Review chrome, strip and change rows each use one line. Success has no toast.
- A draft-only tab is the document's one tab, never persisted; its address (document and item key)
  reopens it. Only a command's own outcome settles it (`useWorkDraftCommands.settleTab`: an Apply that
  closed the item promotes it, an item Discard removes it). A list, a metadata read or a 404 never does.
- Presentational components receive props and callbacks, not controllers.

## Links

- [Reference][reference]
- [Editor adapter contracts](../editor/.context/CONTEXT.md)
- [Session and extension contracts](../../core/editor/.context/CONTEXT.md)
- [Runtime verification recipes](../../../../../docs/qa/draft-review.md)

[reference]: .context/draft-review.md
