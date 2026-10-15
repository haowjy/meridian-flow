# domains/collab — server-side branch collaboration

This domain owns durable live and Work-draft Yjs coordination, persistence,
review settlement, and Hocuspocus admission. It composes
`@meridian/agent-edit`; it does not own editor UI or transport-shell policy.

## Mental model

- Live documents, Work drafts, and thread peers are real Y.Docs. Journals and
  durable authority heads are the source from which runtime state is rebuilt.
- A Work draft is shared by every thread editing that document in that Work. A
  text branch holds `prosemirror` (the draft text) and the server-owned
  `review_base`; the review is the browser's projection of one against the other,
  and the server stores no review operations, classes or tokens.
- A text branch shares no Yjs lineage with live: it catches up by a three-way
  content rebase on live's certified cut, never a Yjs pull (thread peers still
  pull). A stale peer frame is rebased onto the current text; what cannot be
  placed exactly is recovered as written text, never silently dropped.
- Apply is a content merge into live's current text and never closes the draft.
  Discard is a writer edit inside the room, undone by Ctrl+Z, with no command;
  only item Discard and Discard all are kernel commands, and they only close.
- Authority identity and generation fence every live connection and mutation.
  The domain owns authorization, persistence, coordination, settlement, and
  trail projection around the agent-edit core.

## Rules that change behavior

- Keep the dependency one-way: collab may import agent-edit; agent-edit never
  imports server code. `composition.ts` wires required ports and providers;
  behavior belongs in domain services.
- Admit novel writer content durably before Yjs apply, broadcast, or ack.
  Treat Yjs merge as trusted: destructive evidence informs receipts and marks,
  never a veto. Undo recovers.
- Every server write into a text branch goes through `writeBranchState`, computed
  against the state it compare-and-swaps onto under the branch lease. Never
  store a server-client delta and replay it later: Yjs drops it silently. Reject
  writer updates that touch reserved client ids or `review_base`.
- Branch Y.Docs use `gc: false`. Any apply after an `await` must use the
  documented durable authority/concurrency fence; a coordinator lock alone is
  not enough.
- A reply saves every document it wrote in one transaction. Live publication
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
The focused references are [branch records](.context/branch-model-and-records.md),
[document authority](.context/document-authority-and-schema.md),
[reversal](.context/reversal.md),
[settlement](.context/settlement-and-trail.md), and
[WebSocket concurrency](.context/websocket-concurrency.md).
The visual references are [collab-domain.html](.context/collab-domain.html)
and [draft-live-model.html](.context/draft-live-model.html).
Deferred work is in [FUTURE.md](.context/FUTURE.md), [TODO.md](.context/TODO.md),
and [TODO](.context/TODO). Related boundaries are [`domains/notices`](../notices/AGENTS.md)
and [`@meridian/agent-edit`](../../../../../packages/agent-edit/AGENTS.md).
