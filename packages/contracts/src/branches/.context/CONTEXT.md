# branches contracts — the review wire

Five names; never let one stand in for another.

| Name | Is | On the wire as |
|---|---|---|
| **branch** | The Work's one active branch (a `branches` row). Closes only on Discard all and purge. | `branchId` |
| **item** | One document's reviewable change inside the branch, with or without a text draft (an empty create and a created image have none). | `itemKey` (`${branchId}:${documentId}`) |
| **draft** | The server's per-document text draft in a branch. Stable for one room lifetime. | addressed `draftId`, `hasDraft` and opaque `reviewRoomName` |
| **command** | One writer action (Apply, Un-Apply, Discard, a chat card's Undo or Redo, or a Copy), one `document_commands` row. | a client-made `commandId` |
| **presented address** | What the writer is looking at: `{ ownerKey, itemKey, changeId? }`. | `item=` and `change=` in the URL, the API review selector `reviewOwner` + `itemKey` |

The client never reads `branchId` as a document draft id; the server alone maps an `itemKey`
to a draft (collab `domain/branch-review-identity.ts`). Text Apply instead binds the captured
`draftId` and never retargets it. The contracts expose the stable draft identity, not storage
table names.

`change=` can display the current selection id, but a bare id cannot restore selection into a
newer projection. Launch focus carries its immutable `ReviewFrame`: the text diff projection
and the Yjs snapshot it describes.

## Metadata and lists

- `ThreadDraftListItem` rows are current reviewable work only; completed review is not a
  durable list receipt. Their `contextLocation` keeps the scheme and the path's leading slash.
- `actorThreads` lists chats whose receipt parts belong to current changes, newest first, then
  the creating chat if absent. Identity resolution reads metadata and tree facts only; list
  enrichment classifies membership.
- A provenance read addresses an already admitted room, not a new room lookup. It accepts only
  unresolved clock ranges for writer receipts; single-user projects omit them and never query
  human history. Missing owner metadata must not drop a part's item ranges.
- `hasDraft` reports text-draft existence only.

## Commands

A text `ApplyClick` carries a UUID command id, the captured `draftId`, a base64
`Y.encodeSnapshotV2` snapshot, one block-range `baseViewDelta` and unique nonempty projection
group ids. A still-hidden creation with no text room uses empty groups and delta and omits both
snapshot and draft id; the server verifies that in the reveal transaction. Every other
empty-group click is malformed. See the [Apply storage
contract](../../../../../apps/server/server/domains/collab/.context/apply.md). Patch blocks are
ProseMirror node JSON; the server constructs and validates the nodes.

The authenticated scope and whole body are part of the request digest. Server item Discard takes
`{ branchId, itemKey, commandId }` only to end a still-hidden creation's use; Discard all takes
`{ branchId, commandId }` and closes drafts.
