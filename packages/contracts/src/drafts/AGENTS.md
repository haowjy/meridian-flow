# contracts/drafts — branch-review wire DTOs

This directory keeps the historical `drafts` API vocabulary used by the review
UI, but the model is branch-backed. A `draftId` on the wire is a review-card id;
new flows should prefer `branchId` when addressing sync or mutation operations.

Do not add lifecycle statuses such as `accepting`, `reactivating`, `applied`, or
`discarded`. Reviewable work is active branch work or closed history derived from
server state.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
