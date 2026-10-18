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
- Preview responses carry `branchId` and `itemKey`, the generation-fenced
  `reviewRoomName`, live markdown, draft markdown, review operations and
  hunks. Agent operations carry `actorThreadId` and `actorThreadTitle` (the
  chat title at preview time); writer operations carry neither. A preview that
  cannot be read answers a refusal (`corrupt` carries the `branchId` so the
  writer can discard the whole branch).
- `draftGeneration` (list row and preview) is the draft's generation; it is
  null for an item with no draft. A reset keeps the draft and the item and
  moves the generation up, so the number orders proposals of one item and never
  decreases. The preview's `reviewRoomName` and tokens belong to its
  generation. `draftRevisionToken` is only the stale-command fence and is not an
  identity.

## Commands

Every command carries a `commandId`. A resend reuses it and the server
deduplicates; a different command under a used id answers 409
`command_conflict`. `GET …/branches/commands/:commandId` observes a command:
`pending`, `done` (with exactly the 200 body), `blocked` (terminal; show the
failure on the item), or 404 `unknown_command` (nothing committed, resend).

- **Item Apply and Discard** address `{ branchId, itemKey, commandId }`. Item
  Apply is unfenced by operation ids. It answers `applied` (with notes), 409
  `held` (5a, such as `path_taken`) or 409 `stale`, or 202 `pending` while
  recovery finishes. Apply never closes the branch.
- **Per-change Apply** sends every operation id of the selected
  `closureClassId`s plus the preview's opaque `liveRevisionToken` and
  `draftRevisionToken`. It answers `applied` with the applied `operationIds`
  and `closureClassIds`, or `stale`, `gone`, `whole_item` (a new document, which
  is applied whole) or `incomplete_class`, all as HTTP 200.
- **Per-change Discard** sends `closureClassIds`, server-vended
  `admissionTokens` over the clicked classes' closed rows and rich effect, and
  both revision tokens. `memberPartKeys` only classify a class that is gone.
  `operationIds` are not part of the request. Missing or changed evidence
  returns `stale`; unrelated typing does not. Stable class identity alone is
  never admission evidence.
- **Apply all** sends `{ branchId, commandId, items: [{ itemKey, locationToken,
  liveTextToken?, draftGenerationToken? }] }`, each item once. `completed`
  means the command settled, including a selection whose items were all held;
  `stale` names `staleItemKeys`; `gone` is not the Work's active branch.
- **Discard all** sends `{ branchId, commandId }` and is the only command whose
  `discarded` closes the branch. Its `branchId` is a `branches` row, never a draft
  id.
- Successful item and per-change responses add `itemClosed`; when true,
  `itemDisposition` names the settled review (`applied` if any content reached
  live, otherwise `discarded`). The client never infers closure from operation
  counts or from the list.

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
