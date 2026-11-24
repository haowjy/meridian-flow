# drafts contracts — the review wire

Four names; never let one stand in for another.

| Name | Is | On the wire as |
|---|---|---|
| **draft** | A `drafts` row: the pending changes one Work, or one chat lineage under No Work, holds. | `draftId`, or `draft` |
| **item** | One document's reviewable change in a draft: its fork's text changes, its tree records, or both. | `itemKey` (`${draftId}:${documentId}`) |
| **command** | One writer action (a press or its Undo, a chat card's Undo, or a Copy), one `commands` row. | a client-made `commandId` |
| **presented address** | What the writer is looking at: the draft item, whether Review changes is on and against what, and the change in focus. | `item=`, `review=` and `change=` in the URL |

A draft's text changes are what its fork room of the document (`fork:<draft>:<document>`) holds
that Live does not: `changedBlocks` in `@meridian/document-model` groups them into changes.
`change=` names one by the id of any of its members (a block id, or a comment id).

## Lists

- `DraftItem` rows are current reviewable work only; completed review is not a
  durable list receipt. Their `contextLocation` keeps the scheme and the path's leading slash.
- `actorThreads` lists chats whose writes landed in the draft's fork of the item (their receipts
  name the fork), then the creating chat if absent.
- `pending` says the draft's fork differs from Live; false means the item is only a created, moved
  or deleted document. No count of text changes is listed (design §6).
- A draft id the server has not stored yet (a Work or chat whose create is still on its way)
  lists as empty, so the browser reads the draft it minted at once. A press needs the stored draft.

## Commands

A press (`press.ts`) is a verdict (`apply`, `discard`, or a turn's `restore`) on a scope: one
change, a document, a draft, or the drafts of a Work; with `saw` (the tree cut) and
`liveVersions` (the Live text the writer was shown). Every Work and root chat carries its draft
from its creation.
Its Undo names the press's command id. The authenticated scope and whole body are part of the
request digest. The server side is [the press](../../../../../apps/server/server/domains/collab/.context/press.md).
