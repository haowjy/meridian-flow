# branches contracts — the review wire

Four names; never let one stand in for another.

| Name | Is | On the wire as |
|---|---|---|
| **branch** | The Work's one active branch (a `branches` row): its pending tree records. | `branchId` |
| **item** | One document's reviewable change in a Work: its suggestions, its tree records, or both. | `itemKey` (`${branchId}:${documentId}`) |
| **command** | One writer action (a press or its Undo, a chat card's Undo, or a Copy), one `commands` row. | a client-made `commandId` |
| **presented address** | What the writer is looking at: `{ ownerKey, itemKey, changeId? }`. | `item=` and `change=` in the URL |

A Work's text draft is its suggestion marks in the Live document, so there is no draft id on the
wire. `change=` names a suggestion id in that document.

## Lists

- `ThreadDraftListItem` rows are current reviewable work only; completed review is not a
  durable list receipt. Their `contextLocation` keeps the scheme and the path's leading slash.
- `actorThreads` lists chats whose suggestions are in the item, newest first, then the creating
  chat if absent.
- `hasDraft` reports whether the item holds suggestions; `textChanges` counts them.

## Commands

A press (`press.ts`) is `{ owner, verdict, items | "all", saw?, seen? }`, addressed by the
Work's owner key, not a branch: a Work with suggestions and no tree change has no branch row.
Its Undo names the press's command id. The authenticated scope and whole body are part of the
request digest. The server side is [the press](../../../../../apps/server/server/domains/collab/.context/press.md).
