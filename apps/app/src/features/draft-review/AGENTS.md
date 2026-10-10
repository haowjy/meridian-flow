# features/draft-review — changes under review

Shared review state and presentation for the manuscript, document change list,
Work page and chat strip. One change is one server closure class. Chat and Work
lists can command drafts without opening a review or joining a room.

Read [the lifecycle reference][reference] before changing state or settlement.
It is the single local contract reference; this file maps ownership.

## Ownership map

| Concern | Owner |
|---|---|
| Presented-document review scope | `DraftReviewProvider.tsx`, composed by `ProjectView.tsx` |
| Selected review, shown generation, retained completion, focus | `draft-review-session.ts` reducer |
| View transitions and explicit navigation effects | `useDraftReviewController.ts` |
| Claims, queues, failures, batch leases and read fences | `client/query/draft-command-record.ts` |
| Admission, typed requests, answer publication and refresh ordering | `client/query/draft-command-executor.ts` |
| Creation-bound Work command capability | `useWorkDraftCommands.tsx` |
| Generation observations, room acquisition and eligibility | `useReviewRoomOwner.ts` |
| Review composition, construction receipt and paint readiness | `features/editor/EditorView.tsx` |
| Common editor construction | `features/editor/SessionEditor.tsx` |
| Active editor projection and live presence lease | `useActiveReviewBinding.ts` |
| Remote draft-only settlement | `DraftOnlySettlement.tsx` |
| Cross-container promotion/removal | `draft-only-lifecycle.ts` (Editor route repair delegates to the context removal coordinator) |
| Catalog-labelled files and stable order | `client/query/work-draft-files.ts`, exposed by `useWorkDrafts.ts` |
| Change grouping and attribution | `review-changes.ts`, `change-attribution.ts` |
| Claim-to-review completion projection | `useReviewCommandCompletion.ts` |
| Shared focus reconciliation | `useReconcileReviewFocus.ts` |
| Open-review and unopened-file list models | `useReviewChanges.ts`, `useDraftChanges.ts` |
| Layout-independent header model | `useReviewHeader.ts` |
| Listed-file launch adapter | `features/project/dock/useAiDraftLauncher.ts` (`openReviewFile`) |
| Refusal/failure wording | `ReviewMessageText.tsx` |

Paths outside this directory are relative to `apps/app/src`.

## Load-bearing rules

- Never add a surface-local command lock, optimistic hide or completion store.
  Records own command lifetime; the reducer retains completion for the open review.
- Never infer closure from empty changes or list omission. Use generation-addressed
  observations and the transition table in the reference.
- Commands keep their creation-bound Work and thread invalidation authority.
  Sharing Editor presentation does not borrow Editor command authority.
- Navigation consumes executor admission. Offline clicks do not remove tabs,
  move to another draft or replay on reconnect.
- Room ownership is not editor paint or writer-delivery ownership. Session-layer
  delivery survives leaving review; the room owner has no paint receipt.
- Focus readers are pure. Reconcile once per scope, and address focus requests to
  their intended review rather than the last rendered selection.
- Per-change commands send every operation of the class and the viewed revision
  tokens. Whole-draft commands settle the current server branch, not a preview.
- Unattributed hunks and non-actionable classes remain visible and count toward
  completion coverage. Synthetic class keys never reach the server.
- Draft-only tabs belong to the transient review overlay. Only Apply promotion
  makes one durable; a gone/404 read is not remote-Discard evidence.
- Presentational components receive props and callbacks, not controllers.
  Layout belongs to components; pane continuity belongs to shared `PaintHold`.

## Links

- [Lifecycle and command reference][reference]
- [Editor adapter contracts](../editor/.context/CONTEXT.md)
- [Session and extension contracts](../../core/editor/.context/CONTEXT.md)
- [Runtime verification recipes](../../../../../docs/qa/draft-review.md)
- [Pane continuity](../../components/app/PaintHold.md)
- [Editable draft authority][editable]
- [Server command authority][authority]

[reference]: .context/draft-review.md
[editable]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/draft-review-editable-branch.md
[authority]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/draft-review-command-authority.md
