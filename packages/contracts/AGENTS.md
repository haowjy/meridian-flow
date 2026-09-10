# @meridian/contracts

Shared TypeScript wire contracts for IDs, DTOs, protocols, thread events,
agents, interrupts, preferences, projects, works, branch-backed draft review,
runtime shapes, and observability records.

- `drafts/` is UI vocabulary for branch review cards and Work draft lists. The
  durable backend primitive is a branch (`document_branches` +
  `branch_write_journal`), not legacy draft tables.
- Yjs protocol contracts expose only live rooms and generation-fenced branch
  rooms.
- Every Meridian WebSocket close pair used by a classifier is defined in
  `WS_CLOSE`; classifiers reference registry entries. Transport-local lifecycle
  and failure closes remain owned by their emitting transport.
- Durable trail contracts remain lifecycle-neutral. Receiving-writer attention
  is computed per connection as `ChangeEventProjection.swept`, a best-effort
  live-session hint that never enters `TrailChangeV1` or persisted projections.
- `Usage.inputTokens` is the inclusive input total; the cache counters are
  disjoint subsets of it. Providers disagree here, so the contract is only true
  if every gateway adapter normalizes before returning — `assertValidUsage`
  makes a violation loud rather than a silent billing error.
- Figure and image references carry a stable `assetDocumentId` plus a
  project-relative `assetPath`. Signed URLs are expiring render details and
  never belong in a field a document persists.
- Context entry validation reserves a leading `@` in every path segment for
  Work authority qualifiers. An `@` elsewhere in a segment remains valid.
- `WorkSlug` proves ordinary slug grammar and field role only; UUID-shaped
  slugs are valid. Parsed URI `normalized` text is syntax, while stable
  real-Work serialization requires opaque project-resolved authority.
- Keep types JSON-natural at boundaries.
- Do not import server adapters, database clients, React, or provider SDKs.
