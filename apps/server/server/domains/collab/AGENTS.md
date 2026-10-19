# domains/collab — server-side draft collaboration

This domain owns durable live and Work-draft Yjs coordination, persistence,
review settlement, and Hocuspocus admission. It composes
`@meridian/agent-edit`; it does not own editor UI or transport-shell policy.

## Mental model

- A branch is one Work's pending file tree (`branches`); its document versions
  are drafts (`document_drafts`). Apply leaves the branch open; Discard all closes it.

- Live documents, document drafts, and thread peers are real Y.Docs. Journals and
  durable authority heads are the source from which runtime state is rebuilt.
- A Work draft is shared by every thread editing that document in that Work.
  Review classes and writer attribution are server-derived, dependency-closed,
  and never reconstructed by a client.
- Authority identity and generation fence every live connection and mutation.
  The domain owns authorization, persistence, coordination, settlement, and
  trail projection around the agent-edit core.

## Rules that change behavior

- Keep the dependency one-way: collab may import agent-edit; agent-edit never
  imports server code. `composition.ts` wires required ports and providers;
  behavior belongs in domain services.
- Admit novel writer content durably before Yjs apply, broadcast, or ack.
  Treat Yjs merge as trusted: destructive evidence informs receipts and marks,
  never a veto. Undo and redo are the reversal authority.
- Every server authority doc and every materialization of one is `gc: false`: draft
  and live docs, rooms (`yjs-ws-handler.ts`), clones and scratch docs. A rewrite never
  encodes a gc-on doc, and a client doc (gc on) is never the origin of a Yjs snapshot, since
  `createDocFromSnapshot` throws on it and a once-collected store restores the wrong text
  silently. Model writes materialize their planning view from their recorded frontier snapshot. The [probe](../../../../docs/qa/frontier-survives-compaction.md) is pure Yjs: it pins
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
[settlement](.context/settlement-and-trail.md), and
[WebSocket concurrency](.context/websocket-concurrency.md).
The visual references are [collab-domain.html](.context/collab-domain.html)
and [draft-live-model.html](.context/draft-live-model.html).
Deferred work is in [FUTURE.md](.context/FUTURE.md), [TODO.md](.context/TODO.md),
and [TODO](.context/TODO). Related boundaries are [`domains/notices`](../notices/AGENTS.md)
and [`@meridian/agent-edit`](../../../../../packages/agent-edit/AGENTS.md).
