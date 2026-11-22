# domains/collab

Coordination and persistence for live documents. A document's Live text lives in its Loro room
(`DocumentRooms` on `document_snapshots`, `rooms/postgres-document-rooms.ts`); every read, write,
seed, copy and derivation goes through it. Hocuspocus, the Yjs journal and a Work's suggestion
drafts remain until phase 1b's step 5 deletes them. Phase 1 is Live-only: the file grant sends
every agent write Live (`file-policy/domain/policy.ts`, `destinationAt`), whatever the chat's write
mode.

- A model write is one `modelEdits().write` in its command transaction: a Live one commits a Loro batch through `DocumentRooms` ([model edits](.context/model-edits.md#live-edits-on-loro-rooms)), a drafted one writes the Work's suggestions through `draftView`. Nothing holds a write for a later save.
- Admit novel user content durably before Yjs apply, broadcast or ack.
- Every server authority doc and every materialization of one is `gc: false`. A
  client doc (gc on) can't be the origin of a Yjs snapshot: a once-collected store
  restores the wrong text silently ([probe](../../../../../docs/qa/frontier-survives-compaction.md)).
  A stored checkpoint, and the room once it is stored, drop deleted items' content (ids kept), so no reader may need it: Undo
  reads content (`domain/inverse-text.ts`), and a snapshot reader goes through
  `planningSnapshot`, which refuses a frontier that saw dropped content; a write then plans on
  the transcript's read (agent-edit `tool/read-view.ts`).
- Any apply after an `await` rechecks the durable authority and the
  concurrency fence; a coordinator lock doesn't cover socket writes.
- Anything that runs on a journal or receipt insert, triggers included, adds to every
  keystroke's row hold.
- Derive read models from a cut of the Live room taken under the document's lock and stamped with
  `documents.content_seq`, which every committed Live save bumps. Anything that rewrites room rows
  without changing the text (history compaction) leaves `content_seq` alone.
- Never await `rooms.flush` in a transaction that holds the document's lock: the save takes that
  lock on a connection of its own and waits on you.
- Schema-aware reads, seeds and writes go through `domain/markdown-document.ts` and
  the scoped link codec.
- A press's tree half is the project-tree package's `applyDraft` and `discardDraft`, run
  through `treeListStore.submit` in the press's command transaction (each list the Work spans);
  collab writes no tree row. The list's lock comes after the Works and
  before any document's key (the lock order in `.context/CONTEXT.md`). A press's Discard puts
  what the Work created in live's Trash; its Undo makes it pending in the Work again, and
  Trash's Restore brings it into live instead
  ([press](.context/press.md#discard-and-what-goes-to-trash)); Work purge's leaves it in no view
  until retention purges it.
- A model edit plans under the lock its append takes, on the one connection of its command (`modelEdits().write`). Nothing reachable from it may open a second connection or wait on one; see [model edits](.context/model-edits.md). Each tree tool call is such a command too.
- `mergeCodeText` brings a base→target change into a code document: it takes the document's mutation lock (`lockDocument`) before it reads the live text, then merges and appends under that hold, against what it holds then, and keeps the live text where both changed the same text (an Agent package's Undo). It runs inside the caller's transaction (the coordinator's transaction path takes no process mutex, so the lock never waits behind one); a caller that must merge several documents sorts them by id.
- Destination selection is explicit: don't infer live versus a Work's view from a thread mode.

## Depth

[`.context/CONTEXT.md`](.context/CONTEXT.md) holds the contracts and links its focused pages.
