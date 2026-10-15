# @meridian/contracts

Shared TypeScript wire contracts for IDs, DTOs, protocols, thread events,
agents, context URIs, document links, works, drafts, and observability. This
package defines boundary vocabulary; it does not own server adapters, storage,
React, or provider behavior.

## Mental model

- `drafts/` is the review wire: the Work draft list, item metadata, and the Apply
  and Discard commands. The durable backend primitive is a text branch, which
  never crosses the wire; see [`src/drafts/AGENTS.md`](src/drafts/AGENTS.md)
  and its [context](src/drafts/.context/CONTEXT.md).
- Protocol unions are canonical definitions. WebSocket classifiers use the
  `WS_CLOSE` registry, pending transcript kinds use `PENDING_PLACEHOLDER_ROLES`,
  and thread controls use `ControlBody`.
- Context ownership is exclusive: a named Work owns its drafted schemes, a
  lineage owns Scratch and No Work uploads, and No Work owns uploads only. A
  document owner is a Work or a lineage, never both.
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
