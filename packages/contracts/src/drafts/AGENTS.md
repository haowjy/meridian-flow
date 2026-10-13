# contracts/drafts — Work-draft review wire DTOs

On the `review.ts` shapes, `draftId` (one document's branch) is the identity for
preview, per-document Apply and Discard. The `apply.ts` shapes use D68 names: a
whole draft's `draftId`, each item's `itemKey`, and `draftBranchId` for its
branch. Wire DTOs never expose any other storage identity. `reviewRoomName` is an opaque,
generation-fenced transport address, not another application identity.

Each row carries its document URI's `contextLocation: { scheme, path } | null`
(with a leading slash on the path), not a manuscript-only path.

The list contains current reviewable work only; completed review is not retained
as a draft-list receipt.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)

Review rows carry `contextLocation: { scheme, path } | null`, parsed from the
item URI. The path has a leading slash; launchers and review tabs preserve its
scheme, including draft-only documents outside Manuscript.
