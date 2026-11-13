# domains/collab

Durable Yjs coordination and persistence for live documents and Work drafts.

- Seed a Work draft content-only: client 1 writes live's blocks into `prosemirror`
  and `review_base`. Don't merge live's Yjs identity into a draft; the draft/live
  boundary is content-based.
- Thread peers keep binding identity only. Model reads and saves use the Work draft.
- Admit novel user content durably before Yjs apply, broadcast or ack.
- Every server authority doc and every materialization of one is `gc: false`. A
  client doc (gc on) can't be the origin of a Yjs snapshot: a once-collected store
  restores the wrong text silently ([probe](../../../../../docs/qa/frontier-survives-compaction.md)).
- Any apply after an `await` rechecks the durable authority, its generation and the
  concurrency fence; a coordinator lock doesn't cover socket writes.
- A draft append is ordered by its draft row lock: add no revision check, retry or
  Work lock to it. Review membership and the Works badge catch up in the projection
  job. Rewrites keep their revision fence. Anything that runs on a journal or receipt
  insert, triggers included, adds to every keystroke's row hold.
- Author server rows in `prepareAppend`'s `authorServerRows` callback, under the row
  hold. Client-1 rows authored before the hold can collide on Yjs clocks.
- Derive read models from a journal-locked durable cut, not a warm room paired with a
  database watermark.
- Schema-aware reads, seeds and writes go through `domain/markdown-document.ts` and
  the scoped link codec.
- Apply's and Discard's tree halves are the project-tree package's `applyDraft` and
  `discardDraft`, run through `treeListStore.submit` in the click's transaction (each list
  the Work spans); collab writes no tree row. The list's lock comes before any document's
  mutex, and a Discard releases no document: a discarded create stays in no view until
  retention purges it.
- A failed reply's rollback undoes text only. Each tree tool call is its own command.
- Destination selection is explicit: don't infer live versus draft from a thread mode.

## Depth

[`.context/CONTEXT.md`](.context/CONTEXT.md) holds the contracts and links its focused pages.
