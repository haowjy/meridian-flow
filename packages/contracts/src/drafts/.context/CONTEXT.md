# drafts contracts — the review wire

This page defines the review wire's identities and command fences. Keep draft,
item, branch, command, and presented address distinct at every boundary.

The contracts name five things; never let one stand in for another.

| Name | Is | On the wire as |
|---|---|---|
| **draft** | The Work's one active draft (a `drafts` row). Closes only on Discard all and purge. | `draftId` |
| **item** | One document's place in the draft, with or without a text branch (an empty create and a created image have none). | `itemKey` (`${draftId}:${documentId}`) |
| **text branch** | The server's per-document branch of a draft. Its id is the room identity and never crosses the wire. | the server-returned `roomName` only |
| **command** | One writer action that reaches the server (Apply, item Discard, Discard all). | a client-made `commandId` |
| **presented address** | What the writer is looking at: `{ workId, itemKey, changeId? }`. | `item=` and `change=` in the URL, the API review selector `reviewWorkId` + `itemKey` |

The client never reads `draftId` as a branch id and never builds or parses a
room name. The server alone maps an `itemKey` to a branch (collab
`domain/draft-review-identity.ts`).

## Rows, metadata and attribution

- `ThreadDraftListItem` rows are the listed items of the Work draft: a created
  node, or an edited item whose text branch has changes. `actorThreads` lists
  chats with pending agent writes, latest first, with current titles (or null).
  These are candidates: a chat's writes may have been overwritten or
  discarded. The chat strip (`ThreadDraftFilesResponse`) is the same rows
  restricted to one chat.
- `DraftItemMeta` (`GET …/documents/:documentId/draft?itemKey=`) answers for
  every addressable item, listed or not. A `text` item returns `roomName`,
  `isNew`, `wholeItem` and `hasChanges`; a `branchless` item has no room and
  only item-level actions. A 404 `{ code: "gone" }` means the item is closed.
  The review itself is computed in the browser from the room: there is no
  preview body, no server-vended hunks, and no refusal state.
- `DraftAttribution` is a hint that names chats on changes by Yjs item ranges.
  Nothing gates on it.
- A draft keeps one text branch per item until that item closes; a closed item
  that is written again gets a new branch and so a new `roomName`. There is no
  branch generation on the wire or in the store.

## Commands

Every command body is strict (unknown fields answer 400) and carries a
`commandId`. A resend reuses it and the server deduplicates; a different
command under a used id answers 409 `command_conflict`.
`GET …/drafts/commands/:commandId` observes a command: `pending`, `done` (with
exactly the 200 body), `blocked` (terminal; show the failure on the item), or
404 `unknown_command` (nothing committed, resend).

- **Apply** is content Apply: the change merges into live's current text.
  `apply_changes` sends `{ draftId, itemKey, commandId, changeIds, snapshot }`;
  `apply_items` (an item, or Apply all's items) sends the item with an optional
  `snapshot` and an optional `locationToken`. `snapshot` is the base64
  `Y.snapshot` of the room frame the writer acted on, capped at 64 KiB. Apply
  never closes the draft, and never closes an edited item, even when it empties.
- **Results** (`DraftItemOutcome`, one per item): `applied` (with `notes`,
  `overrode`, `hasChanges`, and `itemClosed` when the Apply dropped a created
  item's row), `already_live`, `held` (such as `path_taken`),
  `not_found`, or `failed` with a `DraftApplyFailure` reason. Item routes add
  `stale` (the item's location moved, or it is not addressable), `whole_item` (a per-change Apply of a
  whole-item item) and `gone`. `overrode` is the live text the merge replaced:
  one dismissible notice, never a gate. `hasChanges` is the branch state after
  the command and drives "No changes left" only.
- **Apply all** sends `{ draftId, commandId, items: [{ itemKey, locationToken,
  snapshot? }] }`, each item once. `completed` carries a `DraftItemOutcome` per
  item; `stale` names `staleItemKeys`; `gone` is not the Work's active draft.
- **Item Discard** sends `{ draftId, itemKey, commandId }`, only for whole-item
  items (a created, binary or live-deleted document). It closes the item and
  answers `discarded` or `gone`.
- **Discard all** sends `{ draftId, commandId }` and is the only command whose
  `discarded` closes the draft. Its `draftId` is a `drafts` row, never a branch
  id.
- **Local Discard is not a command.** Discarding a change, a draft in a
  review, a strip row or a Work row is a writer edit in the room. It has no
  body, no result and no observation.
- Item results add `itemClosed`; when true, `itemDisposition` names the settled
  review (`applied` for a created item an Apply revealed, `discarded` for item
  Discard). The client never infers closure from the list or from
  `hasChanges`.

## Reading a review

The server owns no review diff. The browser projects a room into changes
(`@meridian/agent-edit/diff`, `projectReview`) and names each by `changeId`;
`changeIds` in a request name changes of the frame the writer saw. Trail
evidence and peer marks are read-only. Ctrl+Z in an editor undoes the writer's own edits and
Discards in that surface; Apply is a server command with no Ctrl+Z, and an AI
change is undone by the model's `revert`, never a review command.

The contracts expose no durable storage identity or table name. The collab
domain maps an `itemKey` to `document_branches` and owns
`branch_write_journal` and `push_lineage` integration.
