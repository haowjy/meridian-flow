# @meridian/contracts

Shared TypeScript wire contracts for IDs, DTOs, protocols, thread events,
agents, interrupts, preferences, projects, works, branch-backed draft review,
runtime shapes, and observability records.

- `drafts/` is UI vocabulary for branch review cards and Work draft lists. The
  durable backend primitive is a branch (`document_branches` +
  `branch_write_journal`), not legacy draft tables.
- Yjs protocol contracts expose only live rooms and generation-fenced branch
  rooms.
- Durable trail contracts remain lifecycle-neutral. Receiving-writer attention
  is computed per connection as `ChangeEventProjection.swept`, a best-effort
  live-session hint that never enters `TrailChangeV1` or persisted projections.
- Keep types JSON-natural at boundaries.
- Do not import server adapters, database clients, React, or provider SDKs.
