# @meridian/contracts

Shared TypeScript wire contracts for IDs, DTOs, protocols, thread events,
agents, context URIs, document links, works, branches, and observability. This
package defines boundary vocabulary; it does not own server adapters, storage,
React, or provider behavior.

## Mental model

- `branches/` owns review DTOs. A branch is a Work's pending file tree; a
  draft is one document's pending version (`document_drafts`). See
  [`src/branches/AGENTS.md`](src/branches/AGENTS.md) and its
  [context](src/branches/.context/CONTEXT.md).
- Protocol unions are canonical definitions. WebSocket classifiers use the
  `WS_CLOSE` registry, pending transcript kinds use `PENDING_PLACEHOLDER_ROLES`,
  and thread controls use `ControlBody`.
- Run state is one whole versioned `RunState` record (works or idle, open
  execution, owed messages, applied write mode, usage block). Every carrier
  holds the whole record, replaced by version: snapshot, subscribe, the
  `meridian.run_state` frame and every command answer. Never add a second event
  or answer field for a fact the record carries, and never infer run state from
  arrival order or transcript ancestry.
- Context ownership is exclusive: a named Work owns its drafted schemes, a
  lineage owns Scratch, and a chat (a primary thread) owns uploads. A
  document owner is one of a Work, a lineage, or a chat, never two.
- Stored document links carry refs as internal identity and spell destinations
  only at the wire boundary. The same resolver and filename codec serve app,
  server, and tooling consumers.

## Rules

- Keep boundary types JSON-natural and provider-neutral. Do not import server
  adapters, database clients, React, or provider SDKs.
- `Usage.inputTokens` includes the disjoint cache counters; gateway adapters
  normalize provider responses before validation.
- Asset references persist a stable document id and project-relative path, not
  expiring signed URLs. Model-only text elisions belong to compaction metadata,
  never transcript block lifecycle fields.
- Agent execution knobs, aliases, patch presence, and effort mapping have one
  canonical definition in `src/agents/execution-knobs.ts`.
- Work slugs prove syntax, not authority. URI formatting does not grant Work
  access; resolve opaque Work authority before stable serialization.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for URI, link, filename,
retention, and cross-package contract details.
