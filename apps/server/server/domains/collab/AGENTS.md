# domains/collab — server-side branch collaboration

This domain composes `@meridian/agent-edit` with Meridian persistence and
Hocuspocus transport. It owns durable live and branch Yjs infrastructure, not
editor UI or transport-shell policy.

## Mental model

- Live documents, per-thread peers, and per-Work review drafts are real Y.Docs.
  Sync propagates between them; journals are durable and runtime state is
  reconstructible.
- A Work draft is shared by every thread editing the same document in that Work.
  Apply publishes its whole current branch; Discard operates on server-vended
  review classes rather than client-reconstructed turns.
- Each live document has a durable authority head whose identity, generation,
  and admission sequence fence every connection and mutation.
- `@meridian/agent-edit` owns schema-safe mutation and reversal planning. This
  domain owns authorization, persistence, coordination, settlement, and trail
  projection around that core.

## Decision-changing rules

- Keep dependencies one-way: collab adapters import `@meridian/agent-edit`; the
  package must not import server code.
- Admit novel writer content durably before Yjs apply, broadcast, or ack. Route
  live and branch writes through their coordinator-owned admission seams.
- Reject writer updates with reserved client IDs or mutations in the reserved
  provenance namespace before durable append or Yjs apply.
- Yjs merge is trusted. Destructive effects inform marks and receipts but never
  veto an otherwise valid merge; receipt Undo/Redo remains reversal authority.
- Branch Y.Docs use `gc: false`; reversal dependency checks require their full
  struct history.
- Any content apply after an `await` must obey the documented WebSocket
  concurrency fence. Do not assume a coordinator lock excludes socket writes.
- Route schema-aware content reads, seeds, and writes through
  `domain/markdown-document.ts`.

Deep contracts and verification guidance live in [`.context/CONTEXT.md`](.context/CONTEXT.md).
Related boundaries: [`domains/notices`](../notices/AGENTS.md) and
[`@meridian/agent-edit`](../../../../../packages/agent-edit/AGENTS.md).
