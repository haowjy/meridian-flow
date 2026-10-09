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
  resolved configuration shape, each closed value set (effort, permission), the
  tool-list schema and its alias fold, and the presence-sensitive patch schema
  are declared once. Tool lists are arrays of real tool names; `edit` is
  permission, never a tool. The compiler, resolver, invocation patch, and effort provider mapping
  are projections; do not re-declare an effort set or tool alias map.
- Context entry validation reserves a leading `@` in every path segment for
  Work authority qualifiers. An `@` elsewhere in a segment remains valid.
- `document-href.ts` is the one place a standard Markdown link's destination
  is resolved (`resolveDocumentHref`), spelled (`spellDocumentHref`),
  respelt while preserving style (`respellDocumentHref`), and matched to a
  catalog path (`matchDocumentPath` through `documentPathKey`). Address-index
  keys come only from `documentAddressKey`, which requires explicit Work authority.
  Both link resolvers, the
  Editor clipboard, `@` insertion, LinkForm and the composer's reference
  spelling call it. Never format a destination from a raw URI or
  re-implement relative resolution: two copies of it once disagreed, and a raw
  `#` or `%` in a filename silently names another document.
- `document-ref.ts` owns the stored link ref grammar (`doc:<id>`, `ahead:<id>`),
  the only ahead-ref mint, and `aheadAddress`. `document-link.ts` owns the one
  stored-link resolution (`resolveStoredLink` over a host `LinkCatalog`), the
  one written-link classifier (`classifyWrittenLink`/`classifyWrittenSource`;
  the single definition of "contextual"), and the speller (`spellStoredLink`).
  A ref never appears in Markdown, HTML, URIs or model text; a ref the reader
  cannot reach spells its stored href, never its target's new location.
- `WorkSlug` proves ordinary slug grammar and field role only; UUID-shaped
  slugs are valid. Parsed URI `normalized` text is syntax, while stable
  real-Work serialization requires opaque project-resolved authority.
- `PENDING_PLACEHOLDER_ROLES` in `threads/` defines pending transcript
  placeholders (`compaction` and handoff seed `system`); the database partial
  index and orphan-repair queries derive from it.
- `ControlBody` in `threads/` is the one list of thread control kinds
  (`compact`). Four restatements do not
  fail to compile when a kind is missing, so change them with it: the
  websocket pending schema (`protocol/ws-protocol.ts`), the controls route's
  request schema, runtime `pending-inbox.ts`, and the database inbox body
  check (`schema/agent-threads.ts`, then regenerate). A missing kind drops that
  queued item from the tray or fails its enqueue.
- Work retention timing is canonical in `src/works/work-retention.ts`; server jobs and UI countdowns consume its exported constants and helpers.
- Keep types JSON-natural at boundaries.
- Do not import server adapters, database clients, React, or provider SDKs.
- Blocks describe the writer transcript. Model-only document-text elisions belong
  to compaction metadata, never a block lifecycle flag or client event.
