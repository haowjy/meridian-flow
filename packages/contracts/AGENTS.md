# @meridian/contracts

Shared TypeScript wire contracts for IDs, DTOs, protocols, thread events,
agents, interrupts, preferences, projects, works, branch-backed draft review,
runtime shapes, and observability records.

- `drafts/` is UI vocabulary for branch review cards and Work draft lists. The
  durable backend primitive is a branch (`document_branches` +
  `branch_write_journal`), not legacy draft tables.
- Yjs protocol contracts expose live rooms and generation-fenced branch rooms;
  draft rooms are deleted.
- Keep types JSON-natural at boundaries.
- Do not import server adapters, database clients, React, or provider SDKs.
