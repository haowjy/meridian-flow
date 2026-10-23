# domains/collab — server-side draft collaboration

Durable Yjs coordination and persistence for live documents and Work drafts,
change-trail persistence, and Hocuspocus admission. It composes
`@meridian/agent-edit`; it owns neither editor UI nor transport-shell policy.

## Mental model

- A branch is one Work's pending file tree (`branches`); its document versions
  are drafts (`document_drafts`). Apply leaves the branch open; Discard all
  closes it.
- A Work draft is shared by every thread editing that document in that Work.
  It is seeded content-only: client 1 writes live's blocks into `prosemirror`
  and `review_base`. Never merge live's Yjs identity into a draft. Thread peers
  keep binding identity only; model reads and saves use the Work draft.
- Live documents, drafts and thread peers are real Y.Docs, rebuilt from
  journals and durable authority heads.
- Review is computed in the browser from the draft room. Apply commits its
  frozen clicked content into live and the review base in one transaction
  ([Apply](.context/apply.md)).
- A draft keeps the room `draft:<draftId>` from seed to close; it has no
  generation.
- Authority identity and generation fence every live connection and mutation.

## Rules

- Dependency runs one way: collab imports agent-edit, never the reverse.
  `composition.ts` wires ports and providers; behavior belongs in domain
  services.
- Admit novel user content durably before Yjs apply, broadcast or ack. Yjs
  merge is trusted: concurrent attribution informs receipts, never vetoes a
  write. Undo and redo are the reversal authority.
- Every server authority doc and every materialization of one is `gc: false`.
  A client doc (gc on) is never the origin of a Yjs snapshot: a once-collected
  store restores the wrong text silently. Model writes plan from their recorded
  frontier snapshot; [this probe](../../../../../docs/qa/frontier-survives-compaction.md)
  pins the Yjs behavior that depends on.
- Any apply after an `await` uses the durable authority and concurrency fence;
  a coordinator lock alone is not enough.
- A draft append (a writer keystroke, a reply's rows) is ordered by its draft
  row lock, never fenced by a revision: add no revision check, retry or Work
  lock to it. Review membership and the Works badge catch up afterward in the
  projection job. Rewrites keep their revision fence. Anything that runs on a
  journal or receipt insert, triggers included, adds to every keystroke's row
  hold.
- Server-authored rows go through `prepareAppend`'s `authorServerRows` callback
  under the row hold; never author client-1 rows before the hold.
- A reply saves every document it wrote in one transaction; open editors see it
  only after commit.
- Derive read models from a journal-locked durable cut, never a warm room paired
  with a database watermark. Schema-aware reads, seeds and writes go through
  `domain/markdown-document.ts` and the scoped link codec.
- Scratch and upload content is never drafted, but its placement can belong to
  a Work branch. Destination selection is explicit;
  never infer live versus draft from a thread mode.

## Depth

[`.context/CONTEXT.md`](.context/CONTEXT.md) holds the contracts, including
close codes and the draft runtime. Focused pages:
[draft records](.context/draft-model-and-records.md),
[document authority](.context/document-authority-and-schema.md),
[reversal](.context/reversal.md), [committed trail](.context/change-trail.md),
[WebSocket concurrency](.context/websocket-concurrency.md). Deferred work:
[TODO](.context/TODO.md), [FUTURE](.context/FUTURE.md). Related:
[`domains/notices`](../notices/AGENTS.md),
[`@meridian/agent-edit`](../../../../../packages/agent-edit/AGENTS.md).
