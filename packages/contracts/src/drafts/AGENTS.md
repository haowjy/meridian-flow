# contracts/drafts — branch-review wire DTOs

This directory keeps the historical `drafts` API vocabulary used by the review
UI, but the model is branch-backed. A `draftId` on the wire is a review-card id;
new flows should prefer `branchId` when addressing sync or mutation operations.
Today the server has one active Work-draft branch per `(documentId, workId)`,
and its list aliases that branch to one review card. Distinct `draftId` and
`branchId` fields do not imply multiple independently disposable
same-document drafts.

The list is active-only. Do not add lifecycle statuses such as `accepting`,
`reactivating`, `applied`, `discarded`, or `closed`; completed review is not
retained as a draft-list receipt.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
