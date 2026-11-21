# drafts contracts — the review wire

Four names; never let one stand in for another.

| Name | Is | On the wire as |
|---|---|---|
| **draft** | A `drafts` row: the pending changes one Work, or one chat lineage under No Work, holds. | `draftId`, or `draft` |
| **item** | One document's reviewable change in a Work: its suggestions, its tree records, or both. | `itemKey` (`${draftId}:${documentId}`) |
| **command** | One writer action (a press or its Undo, a chat card's Undo, or a Copy), one `commands` row. | a client-made `commandId` |
| **presented address** | What the writer is looking at: `{ itemKey, changeId? }`. | `item=` and `change=` in the URL |

A draft's text changes are its suggestion marks in the Live document, each mark naming the draft
id. `change=` names a suggestion id in that document.

## Lists

- `DraftItem` rows are current reviewable work only; completed review is not a
  durable list receipt. Their `contextLocation` keeps the scheme and the path's leading slash.
- `actorThreads` lists chats whose suggestions are in the item, newest first, then the creating
  chat if absent.
- `textChanges` counts the item's suggestions; 0 means it has none (a created, moved or deleted
  document with no suggestions in its text).
- A draft id the server has not stored yet (a Work or chat whose create is still on its way)
  lists as empty, so the browser reads the draft it minted at once. A press needs the stored draft.

## Commands

A press (`press.ts`) is `{ draft, verdict, items | "all", saw?, seen? }`, addressed by the draft
id, which every Work and root chat carries from its creation.
Its Undo names the press's command id. The authenticated scope and whole body are part of the
request digest. The server side is [the press](../../../../../apps/server/server/domains/collab/.context/press.md).
