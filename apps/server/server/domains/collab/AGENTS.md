# domains/collab

Durable Yjs coordination and persistence for live documents. A Work's draft is its suggestion
marks in the Live document, plus its draft's tree records; Apply and Discard is the press.

- A model write is one `modelEdits().write` in its command transaction; a drafted one writes the Work's suggestions through `draftView`. Nothing holds a write for a later save.
- Admit novel user content durably before Yjs apply, broadcast or ack.
- Every server authority doc and every materialization of one is `gc: false`. A
  client doc (gc on) can't be the origin of a Yjs snapshot: a once-collected store
  restores the wrong text silently ([probe](../../../../../docs/qa/frontier-survives-compaction.md)).
  A stored checkpoint, and the room once it is stored, drop deleted items' content (ids kept), so no reader may need it: Undo
  reads content (`domain/inverse-text.ts`), and a snapshot reader goes through
  `planningSnapshot`, which refuses a frontier that saw dropped content; a write then plans on
  the transcript's read (agent-edit `tool/read-view.ts`).
- Any apply after an `await` rechecks the durable authority, its generation and the
  concurrency fence; a coordinator lock doesn't cover socket writes.
- Anything that runs on a journal or receipt insert, triggers included, adds to every
  keystroke's row hold.
- Derive read models from a journal-locked durable cut, not a warm room paired with a
  database watermark.
- Schema-aware reads, seeds and writes go through `domain/markdown-document.ts` and
  the scoped link codec.
- A press's tree half is the project-tree package's `applyDraft` and `discardDraft`, run
  through `treeListStore.submit` in the press's command transaction (each list the Work spans);
  collab writes no tree row. The list's lock comes after the Works and
  before any document's key (the lock order in `.context/CONTEXT.md`), and a Discard releases
  no document: a discarded create stays in no view until retention purges it.
- A model edit plans under the lock its append takes, on the one connection of its command (`modelEdits().write`). Nothing reachable from it may open a second connection or wait on one; see [model edits](.context/model-edits.md). Each tree tool call is such a command too.
- `mergeCodeText` brings a base→target change into a code document: it takes the document's mutation lock (`lockDocument`) before it reads the live text, then merges and appends under that hold, against what it holds then, and keeps the live text where both changed the same text (an Agent package's Undo). It runs inside the caller's transaction (the coordinator's transaction path takes no process mutex, so the lock never waits behind one); a caller that must merge several documents sorts them by id.
- Destination selection is explicit: don't infer live versus a Work's view from a thread mode.

## Depth

[`.context/CONTEXT.md`](.context/CONTEXT.md) holds the contracts and links its focused pages.
