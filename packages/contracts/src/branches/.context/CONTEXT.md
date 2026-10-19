# branches contracts — the review wire

This page defines the review wire's identities and command fences. Keep branch,
item, draft, command, and presented address distinct at every boundary.

The contracts name five things; never let one stand in for another.

| Name | Is | On the wire as |
|---|---|---|
| **branch** | The Work's one active branch (a `branches` row). Closes only on Discard all and purge. | `branchId` |
| **item** | One document's reviewable change inside the branch, with or without a text draft (an empty create and a created image have none). | `itemKey` (`${branchId}:${documentId}`) |
| **draft** | The server's per-document text draft in a branch. Never on the wire. | `draftGeneration` and the opaque `reviewRoomName` only |
| **command** | One writer action (Apply, Discard, per item, per change or for all). | a client-made `commandId` |
| **presented address** | What the writer is looking at: `{ workId, itemKey, changeId? }`. | `item=` and `change=` in the URL, the API review selector `reviewWorkId` + `itemKey` |

The client never reads `branchId` as a document draft id. The server alone maps an
`itemKey` to a draft (collab `domain/branch-review-identity.ts`).

## Rows and previews

- `ThreadDraftListItem` rows describe reviewable items of the Work branch.
  Required `actorThreads` lists chats with pending agent journal writes, latest
  journal id per chat first, with current titles (or null). These are
  candidates: a chat's writes may have been overwritten; previews confirm
  visible changes. Writer and threadless rows are excluded; applied/discarded
  journal rows no longer contribute.
- The legacy metadata-only preview response carries the generation-fenced
  `reviewRoomName`; the deleted server preview no longer supplies operations,
  hunks or actor fields. Browser review comes from the room's text.
- `DraftProvenanceResponse` carries encoded snapshot bytes, the project user,
  AI receipt ranges and nullable owner/reveal metadata. A provenance read
  addresses an already admitted room, not a new room lookup. It accepts only
  unresolved clock ranges for writer receipts; single-user projects omit them
  and never query human history. Missing owner metadata must not drop a part's
  item ranges. Byline names and membership come from the kernel classifier.
- `draftGeneration` (list row and preview) is the draft's generation; it is
  null for an item with no draft. A reset keeps the draft and the item and
  moves the generation up, so the number orders proposals of one item and never
  decreases. The preview's `reviewRoomName` and tokens belong to its
  generation. `draftRevisionToken` is only the stale-command fence and is not an
  identity.

## Commands

`ApplyClick` carries a UUID command id, a base64 `Y.encodeSnapshotV2` snapshot,
one block-range `baseViewDelta` and unique nonempty projection group ids. Patch
blocks are ProseMirror node JSON; the server constructs and validates the nodes.
The reply is for that id only: `applied`, `closed` (including a removal record
when removed), or `refused` with a closed reason enum. Same-id lookups may also
answer `pending`, `conflict`, or `none`. A refusal has no `stale` variant.
The authenticated scope and whole body are part of the request digest.

There is one per-document Apply route, no separate per-change or Work Apply-all
route. Item-form Discard takes `{ branchId, itemKey, commandId }`; Discard all
takes `{ branchId, commandId }`. Legacy request types remain for the client
command-layer deletion only, not as accepted request forms. Legacy results
remain persisted until the settlement services are retired; observation of
those results retains their original body.

## Reading a preview

Incomplete attribution retains an explicit `unclassified: true` hunk; empty
`operationIds` means there is no attributable author, not no difference. Render
its complete removal or insertion (text insertions supply `insertedText` as a
fallback). Do not invent an author. `canApplyOrDiscard: false` disables actions
for every operation of a class touching that hunk; absence means eligible under
the ordinary class rules. Such effects need item-level Apply or Discard.

Trail evidence and peer marks are read-only. Undo of an AI change is the model's
`write undo` or the receipt's Undo, never a review command.

The contracts expose no durable storage identity or table name. The collab
domain maps an `itemKey` to `document_drafts` and owns
`draft_write_journal` and `push_lineage` integration.
