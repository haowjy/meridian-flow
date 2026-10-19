# branches contracts — the review wire

This page defines the review wire's identities and command fences. Keep branch,
item, draft, command, and presented address distinct at every boundary.

The contracts name five things; never let one stand in for another.

| Name | Is | On the wire as |
|---|---|---|
| **branch** | The Work's one active branch (a `branches` row). Closes only on Discard all and purge. | `branchId` |
| **item** | One document's reviewable change inside the branch, with or without a text draft (an empty create and a created image have none). | `itemKey` (`${branchId}:${documentId}`) |
| **draft** | The server's per-document text draft in a branch. Stable for one room lifetime. | addressed `draftId`, `hasDraft` and opaque `reviewRoomName` |
| **command** | One writer action (Apply, Discard, per item, per change or for all). | a client-made `commandId` |
| **presented address** | What the writer is looking at: `{ workId, itemKey, changeId? }`. | `item=` and `change=` in the URL, the API review selector `reviewWorkId` + `itemKey` |

`change=` can display the current selection id, but a bare id cannot restore
selection into a newer projection. Launch focus carries its immutable `ReviewFrame`: the text diff projection and
the Yjs snapshot it describes. Group ids are interpreted only within that
projection; an id alone cannot be applied to a newer one.

The client never reads `branchId` as a document draft id. The server alone maps an
`itemKey` to a draft (collab `domain/branch-review-identity.ts`).

## Metadata and lists

- `ThreadDraftListItem` rows describe reviewable items of the Work branch.
  `actorThreads` lists chats whose receipt parts belong to current changes,
  newest first, followed by the creating chat if absent. Identity resolution
  reads metadata and tree facts only; list enrichment classifies membership.
- `DraftProvenanceResponse` carries encoded snapshot bytes, the project user,
  AI receipt ranges and nullable owner/reveal metadata. A provenance read
  addresses an already admitted room, not a new room lookup. It accepts only
  unresolved clock ranges for writer receipts; single-user projects omit them
  and never query human history. Missing owner metadata must not drop a part's
  item ranges. Byline names and membership come from the kernel classifier.
- `hasDraft` reports text-draft existence only. Its stable `draft:<draftId>` room
  lasts until close; the next proposal has a new draft id.

## Commands

A text `ApplyClick` carries a UUID command id, the captured stable `draftId`, a
base64 `Y.encodeSnapshotV2` snapshot, one block-range `baseViewDelta` and unique
nonempty projection group ids. A still-hidden creation with no text room uses
empty groups and delta and omits both snapshot and draft id; the server verifies
that no-room creation in the reveal transaction. Every other empty-group click
is malformed. See the [Apply storage contract](../../../../../apps/server/server/domains/collab/.context/apply.md). Patch
blocks are ProseMirror node JSON; the server constructs and validates the nodes.
The reply is for that id only: `applied`, `closed` (including a removal record
when removed), or `refused` with a closed reason enum. Same-id lookups may also
answer `pending`, `conflict`, or `none`. A refusal has no `stale` variant.
The authenticated scope and whole body are part of the request digest.

There is one per-document Apply route, no separate per-change or Work Apply-all
route. Text Discard is a local Yjs edit, not an HTTP command. Server item
Discard takes `{ branchId, itemKey, commandId }` only to end a still-hidden
creation's use; Discard all takes `{ branchId, commandId }` and closes drafts.

## Room review

The browser projects text groups and attribution from the draft and review base.
No server preview, journal-operation selection, closure class, admission token,
or presentation-hunk contract remains.

Trail evidence and peer marks are read-only. Undo of an AI change is the model's
`write undo` or the receipt's Undo, never a review command.

The contracts expose the stable draft identity, not storage table names. The collab
domain maps an `itemKey` to `document_drafts` and owns
`draft_write_journal` and `push_lineage` integration.
