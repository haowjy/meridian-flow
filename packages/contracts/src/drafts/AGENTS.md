# contracts/drafts — Work-draft review wire DTOs

`review.ts` holds every shape and uses D68 names: `draftId` is the whole draft,
`itemKey` (`${draftId}:${documentId}`) is the one review identity for a
document, `commandId` names a writer command, and a document's text branch never
crosses the wire. Wire DTOs never expose any other storage identity. `reviewRoomName` is an opaque,
generation-fenced transport address, not another application identity.

Each row carries its document URI's `contextLocation: { scheme, path } | null`
(with a leading slash on the path), not a manuscript-only path.

The list contains current reviewable work only; completed review is not retained
as a draft-list receipt.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)

Review rows carry `contextLocation: { scheme, path } | null`, parsed from the
item URI. The path has a leading slash; launchers and review tabs preserve its
scheme, including draft-only documents outside Manuscript.
