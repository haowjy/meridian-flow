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
  is resolved (`resolveDocumentHref`), spelled canonically (`spellDocumentHref`),
  and matched to a catalog path (`matchDocumentPath` through `documentPathKey`).
  Stored links are never respelt in place: they carry refs and spell on read.
  Both link resolvers, the
  Editor clipboard, `@` insertion, LinkForm and the composer's reference
  spelling call it. Never format a destination from a raw URI or
  re-implement relative resolution: two copies of it once disagreed, and a raw
  `#` or `%` in a filename silently names another document.
- `document-ref.ts` owns the stored link ref grammar (`doc:<uuid>`,
  `ahead:<uuid>`; `parseLinkRef` accepts only canonical UUIDs via
  `parseRequestId`, so a malformed ref is gone and never reaches a lookup;
  `storedLinkRef` keeps a present malformed attr as a ref so it reaches
  resolution as gone instead of falling back to its address), the only
  ahead-ref mint, and `aheadAddress` with `hasFileExtension`, the one rule for
  what address an ahead ref may be registered at (mint and registry alike).
  `document-link.ts` owns the one stored-link resolution (`resolveStoredLink`
  over a host `LinkCatalog`), the one written-link classifier
  (`classifyWrittenLink`/`classifyWrittenSource`; the single definition of
  "contextual", and the whole source grammar: a raw `%` is a literal
  manuscript path, protocol-relative `//host/x` is external; no caller
  reclassifies), and the speller (`spellStoredLink`).
  Addresses (`CatalogDocument.uri`, a classified `uri`, `aheadAddress`,
  registry keys) are decoded canonical URIs; a stored `href`/`src` is an
  escaped spelling. Build every ref-bearing stored href with
  `storedHref(uri, suffix)`, never `uri + suffix`: a raw `#`, `?` or `%` in a
  filename would otherwise become href syntax or decode twice.
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

- Scratch's `@/c12/` qualifier is a lineage owner, not a path segment.
  `@/x` without a first-chat handle is invalid; bare `scratch://x` remains
  contextual. Href traversal and relative spelling cannot cross lineage owners.
- A document's owner is exclusive by type (`ContextOwner`, `context-owner.ts`):
  `workId` or, for Scratch, `rootThreadId` (the first chat's id), never both.
  A tab or placement carries the resolved form with the lineage's handle.
  Flatten to `workId` / `rootThreadId` only at HTTP and storage edges
  (`ProjectContextRequestOptions`). `GET .../context/lineages/:rootThreadId`
  names a lineage by handle and title, trashed first chat included. `WorkingSetRoute` has the same two arms: a
  Work-scoped route carries `workId`, a chat's Scratch route `rootThreadId`.
