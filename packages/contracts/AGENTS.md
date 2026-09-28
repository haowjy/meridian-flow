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
- Agent execution knobs are canonical in `agents/execution-knobs.ts`: the
  resolved configuration shape, each closed value set (effort, tool policy), the
  tool-name alias fold, and the presence-sensitive patch schema are declared
  once. The compiler, resolver, invocation patch, and effort provider mapping
  are projections; do not re-declare an effort set or tool alias map.
- Context entry validation reserves a leading `@` in every path segment for
  Work authority qualifiers. An `@` elsewhere in a segment remains valid.
- `WorkSlug` proves ordinary slug grammar and field role only; UUID-shaped
  slugs are valid. Parsed URI `normalized` text is syntax, while stable
  real-Work serialization requires opaque project-resolved authority.
- `PENDING_PLACEHOLDER_ROLES` in `threads/` defines pending transcript
  placeholders (`compaction` and handoff seed `system`); the database partial
  index derives from it. `RUN_OWNED_PLACEHOLDER_ROLES` defines the subset
  orphan repair may settle (`compaction` only). Keep their SQL predicates and
  runtime checks aligned with these sets.
- `ControlBody` in `threads/` is the one list of thread control kinds
  (`compact`, `compaction_undo`, `handoff_brief`). Four restatements do not
  fail to compile when a kind is missing, so change them with it: the
  websocket pending schema (`protocol/ws-protocol.ts`), the controls route's
  request schema, runtime `pending-inbox.ts`, and the database inbox body
  check (`schema/agent-threads.ts`, then regenerate). A missing kind drops that
  queued item from the tray or fails its enqueue.
- Keep types JSON-natural at boundaries.
- Do not import server adapters, database clients, React, or provider SDKs.
- Blocks describe the writer transcript. Model-only document-text elisions belong
  to compaction metadata, never a block lifecycle flag or client event.
