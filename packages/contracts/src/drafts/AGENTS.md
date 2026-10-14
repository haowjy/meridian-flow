# contracts/drafts — Work-draft review wire DTOs

`review.ts` holds every shape and uses D68 names: `draftId` is the whole draft,
`itemKey` (`${draftId}:${documentId}`) is the one review identity for a
document, `commandId` names a writer command, and a document's text branch never
crosses the wire. Wire DTOs never expose any other storage identity. `roomName`
is the opaque transport address of an item's text branch, returned by the
server; clients never build or parse it.

Each row carries its document URI's `contextLocation: { scheme, path } | null`
(with a leading slash on the path), not a manuscript-only path. The path keeps
its scheme, including draft-only documents outside Manuscript.

The list contains listed items only (created nodes, and edited items that have
changes); completed review is not retained as a draft-list receipt.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
