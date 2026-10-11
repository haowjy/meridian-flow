# drafts contracts — current branch-review contract

The review wire shape is intentionally JSON-natural and UI-oriented:

- List rows describe reviewable Work draft cards.
- Preview responses include required `draftId`, generation-fenced
  `reviewRoomName`, live markdown, branch markdown, review operations, and
  hunks.
- Whole-branch Discard addresses only `draftId`. Per-document Apply addresses
  `draftId` plus optional additive tokens (`DraftApplyTokensSchema`) and answers
  409 `held`/`stale` instead of `applied`. Apply all (`apply.ts`,
  `DraftApplyAllRequest`) names items by `itemKey` with the tokens their review
  rendered; settled answers are 200 with top-level `completed`, even when every
  item was held (F28). Per-item `applied` and `held` keep their meanings. A staged Apply handed
  to recovery answers 202 `{ status: "pending", draftId }` on Apply all,
  per-document Apply and the write-mode switch (F27). This `draftId` names the
  whole draft; the switch has not updated the mode. Registration failure,
  before staging, is 503 with the retryable system error code
  `draft_link_registration_failed`, not a pending acceptance. Selective Discard adds
  operation ids, and the server maps them through its required `closureClassId`.
- Naming (D68, additive until the client phase): on today's `review.ts` shapes
  `draftId` still carries one document's branch id. The new objects in
  `apply.ts` use final names: `draftId` is the whole draft (a drafts row),
  `draftBranchId` one document's branch, `itemKey` is `${draftId}:${documentId}`.
- Trail evidence and peer marks are read-only; reversal lives in turn-receipt
  Undo/Redo.

The contracts do not expose durable storage identities or names. The Work-draft
domain maps `draftId` to `document_branches` and owns
`branch_write_journal`/`push_lineage` integration.
