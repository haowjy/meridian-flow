# features/draft-review — changes under review

Shared review state and presentation for the manuscript, document change list,
Work page and chat strip. One change is one server closure class, or one whole-draft item for a new
document. Chat and Work
lists can command drafts without opening a review or joining a room.

Read [the lifecycle reference][reference] before changing state or settlement.
It is the single local contract reference; this file maps ownership.

## Ownership map

| Concern | Owner |
|---|---|
| Presented-document review scope | `DraftReviewProvider.tsx`, composed by `ProjectView.tsx` |
| Presented document and per-container review address | `features/project/presented-document.ts`, `features/project/ReviewAddressOwner.tsx` |
| Selected review, shown generation, retained completion, focus | `draft-review-session.ts` reducer |
| View transitions and explicit navigation effects | `useDraftReviewController.ts` |
| Per-draft claims, intent queue, failures and read fences | `client/query/draft-command-record.ts` |
| Admission, typed requests, answer publication and refresh ordering | `client/query/draft-command-executor.ts` |
| Creation-bound Work command capability | `useWorkDraftCommands.tsx` |
| Generation observations, room acquisition and eligibility | `useReviewRoomOwner.ts` |
| Review composition, construction receipt and paint readiness | `features/editor/EditorView.tsx` |
| Common editor construction | `features/editor/SessionEditor.tsx` |
| Active editor projection and live presence lease | `useActiveReviewBinding.ts` |
| Remote draft-only settlement | `DraftOnlySettlement.tsx` |
| Cross-container promotion/removal | `draft-only-lifecycle.ts` (Editor route repair delegates to the context removal coordinator) |
| Catalog-labelled files and stable order | `client/query/work-draft-files.ts`, exposed by `useWorkDrafts.ts` |
| Domain change/action index and attribution | `review-changes.ts`, `change-attribution.ts` |
| Claim-to-review completion projection | `useReviewCommandCompletion.ts` |
| Shared focus reconciliation | `useReconcileReviewFocus.ts` |
| Retained projected presentation data | `useOpenReviewChanges.ts`, `draft-changes.ts` |
| Open-review and unopened-file interaction bindings | `useReviewChanges.ts`, `useDraftView.ts` |
| Layout-independent header model | `useReviewHeader.ts` |
| Listed-file launch adapter | `features/project/dock/useAiDraftLauncher.ts` (`openReviewFile`) |
| Refusal/failure wording | `ReviewMessageText.tsx` |

Paths outside this directory are relative to `apps/app/src`.

## Load-bearing rules

- Review navigation consumes the row’s own `contextLocation`; file policy alone
  decides which schemes can have drafts. Draft-only Editor overlays are keyed
  by document, Work and draft, and visible only in their owning Work.

- A slow or refused chapter never locks another chapter. Archived Works remain
  globally read-only; chat generation explicitly gates chat batch controls.
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
- Accepted per-change commands keep an immutable stable member set. Reforks may
  rename rows but never enlarge or shrink that set; incomplete classes refuse.
  Explicit stale answers get one fresh-cut retry only for identical actionable
  members and unchanged server admission evidence. Transport ambiguity and permission failures never retry.
- Per-change commands send every operation of the class and the viewed revision
  tokens. Whole-draft commands settle the current server branch, not a preview.
- Only new documents are one whole-draft
  change. Its actions use existing whole commands; synthetic class keys never
  reach the server. Formatting-only edits are real server-vended classes. Block formatting facts
  render as one localized line in the usual row, without a fake text replacement.
  An empty preview is not terminal-settlement evidence.
- `isWholeDocumentChange` is the shared layout rule: a ready sole whole-draft
  item is its document row, not a file header plus a repeated change. Chat and
  expanded Work files use that row’s name as the review door and keep its
  whole-draft commands. Work rows replace the empty expansion control with an
  alignment spacer. Real per-change items retain their header and rows.
- Review chrome, strip and change rows each use one line. Lists close on last
  disposition; only the header shows completion. Success has no toast.
- Draft-only tabs belong to the transient review overlay. Only Apply promotion
  makes one durable; a gone/404 read is not remote-Discard evidence. Apply and
  Discard settle every container through `draft-only-lifecycle.ts`; Close and
  Back to live stay with the container used. Promotion needs a resolved live
  presentation of the same document, Work and draft, never a flag transition.
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
[editable]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-review-editable-branch.md
[authority]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-review-command-authority.md

Change-row excerpts read complete ordered hunk runs, including attributed
insertions, never the operations’ first-hunk summaries. Only row CSS truncates
their display; repeated words in separate runs remain separate.
