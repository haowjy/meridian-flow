# domains/collab — server-side draft collaboration

This domain owns durable live and Work-draft Yjs coordination, persistence,
change-trail persistence, and Hocuspocus admission. It composes
`@meridian/agent-edit`; it does not own editor UI or transport-shell policy.

## Mental model

- A branch is one Work's pending file tree (`branches`); its document versions
  are drafts (`document_drafts`). Apply leaves the branch open; Discard all closes it.

- Work drafts are content-only fresh seeds: client 1 writes live's blocks into
  `prosemirror` and `review_base`; never merge live's Yjs identity into them.
  Background rebases use one server append under the draft row hold, reading
  committed live without its lock. Thread peers retain binding identity only; model content reads and saves use the Work draft.
- Live documents, document drafts, and thread peers are real Y.Docs. Journals and
  durable authority heads are the source from which runtime state is rebuilt.
- A Work draft is shared by every thread editing that document in that Work.
  Review is computed in the browser from the draft room. The old server
  review, settlement and reset services are deleted. Apply commits its frozen clicked
  content into live and the review base in one transaction; see [Apply](.context/apply.md).
- A draft keeps `draft:<draftId>` from seed to close; it has no generation.
  After commit, ordinary closes send `4205` with `discarded`; removals send `4208`.
- Authority identity and generation fence every live connection and mutation.
  The domain owns authorization, persistence, coordination and
  trail projection around the agent-edit core.

## Rules that change behavior

- Keep the dependency one-way: collab may import agent-edit; agent-edit never
  imports server code. `composition.ts` wires required ports and providers;
  behavior belongs in domain services.
- Admit novel user content durably before Yjs apply, broadcast, or ack.
  Treat Yjs merge as trusted: concurrent attribution informs receipts, never a
  veto. Undo and redo are the reversal authority.
- Every server authority doc and every materialization of one is `gc: false`: draft
  and live docs, rooms (`yjs-ws-handler.ts`), clones and scratch docs. A rewrite never
  encodes a gc-on doc, and a client doc (gc on) is never the origin of a Yjs snapshot, since
  `createDocFromSnapshot` throws on it and a once-collected store restores the wrong text
  silently. Model writes materialize their planning view from their recorded frontier snapshot. The [probe](../../../../../docs/qa/frontier-survives-compaction.md) is pure Yjs: it pins
  the library behaviour this contract depends on and cannot catch a server fold that begins
  encoding a gc-on doc.
- Any apply after an `await` must use the
  documented durable authority/concurrency fence; a coordinator lock alone is
  not enough.
- A draft append (a writer keystroke, a reply's rows) is ordered by its draft
  row lock, never fenced by a revision: do not add a revision check, a retry or
  a Work lock to it. What depends on the committed journal is decided under that
  row lock; review membership and the Works badge catch up afterward in the
  projection job. Rewrites keep their revision fence. Anything that runs when a
  journal or receipt row is inserted, triggers included, adds to every keystroke's
  row hold.
- `draft-runtime.ts` owns the committed replica cache, prefix materialization, prepared
  append/rewrite lifetime, after-root-commit installation/delivery and tail compaction.
  Operation policy stays in `draft-coordinator.ts` and `draft-writer-frames.ts`.
  Server operations use `prepareAppend`'s async-capable `authorServerRows` callback:
  it receives a private post-incoming-row prefix with client 1 set, under the row hold.
  Return captured transaction updates in order; never author client-1 rows before the hold.
- A reply saves every document it wrote in one transaction. Live delivery
  reaches open editors only after commit; failed response replay drops only the
  rejected logical write and its dependent closure.
- Derive read models from a journal-locked durable cut, not a warm room paired
  with a database watermark. Schema-aware document reads, seeds, and writes
  go through `domain/markdown-document.ts` and the single scoped link codec.
  A new door that hands Markdown to a reader joins that scope and prepares it;
  spelling outside a prepared scope throws under test.
- Scratch and uploads are never drafted. Destination selection is explicit;
  collab must not infer live versus draft from a thread mode.

Deep contracts and verification guidance live in [`.context/CONTEXT.md`](.context/CONTEXT.md).
The focused references are [draft records](.context/draft-model-and-records.md),
[document authority](.context/document-authority-and-schema.md),
[reversal](.context/reversal.md),
[committed trail](.context/change-trail.md), and
[WebSocket concurrency](.context/websocket-concurrency.md).
Deferred work is in [FUTURE.md](.context/FUTURE.md) and [TODO.md](.context/TODO.md). Related boundaries are [`domains/notices`](../notices/AGENTS.md)
and [`@meridian/agent-edit`](../../../../../packages/agent-edit/AGENTS.md).
