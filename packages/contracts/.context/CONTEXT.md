# @meridian/contracts — boundary contracts

Rules that span consumers and aren't apparent from one of them.

## Unions other code must follow

`ControlBody` and `PENDING_PLACEHOLDER_ROLES` (`src/threads/`) and the write-mode values
(`src/works/ai-write-mode.ts`) are mirrored by database partial indexes and checks (inbox
body and the `ai_write_mode` columns in `schema/agent-threads.ts` and `schema/content.ts`),
websocket and route schemas, and projections that pick kinds by name (runtime
`run-state.ts`, the app's `features/chat/thread-controls/thread-controls.ts`). Change them
together: a missing kind or mode fails its enqueue or drops the queued item.

Compilers, invocation patches and provider mappings project
`src/agents/execution-knobs.ts` and must not redeclare its value sets.

Every close pair a classifier uses lives in `WS_CLOSE`; transport-local lifecycle closes
stay with their emitting transport.

## Boundary shape

- `Usage.inputTokens` includes the disjoint cache counters, so each gateway adapter
  normalizes provider output before `assertValidUsage`.
- Asset references persist `assetDocumentId` and a project-relative `assetPath`; signed
  URLs are render-time details only.
- Blocks describe the writer transcript. Model-only document-text elisions belong in
  compaction metadata, never in transcript block lifecycle fields.
- Receiving-writer attention is computed per connection as `ChangeEventProjection.swept`,
  a live-session hint that never enters persisted projections.
- Thread snapshots compose the canonical `threadSchema` and `turnSchema`. Identity lookups
  are explicit projections and cannot stand in for full DTO validation.

## Document names

`protocol/document-filename.ts` parses writer names. Identity parsing never depends on
storage kind, and storage suffix selection receives parsed parts explicitly. Move and copy
pass the source extension explicitly, never infer it from filetype.

## Context owners

Rules for addresses and handles are in [owner handles][handles] and the [URI scheme
vocabulary][schemes]. Implementation rules:

- Flatten a `ContextOwner` to its id only at HTTP and storage edges.
- `formatParsedContextUri` formats syntax but never grants authority. Clipboard
  qualification uses the holder's ownership of the scheme; with no applicable owner the link
  stays contextual.
- The Scratch `@c12/` qualifier is a lineage owner, not a path segment: href traversal and
  relative spelling never cross lineage owners.

## Stored links

Link identity is in the [Links KB page][links]. In the code:

- Build ref-bearing hrefs with `storedHref({ kind, uri }, suffix)`, not string concatenation:
  `#`, `?` and `%` in filenames are data. Addresses are decoded canonical URIs; stored `href`
  and `src` values are escaped spellings.
- `document-ref.ts` preserves malformed present refs so they resolve as gone instead of
  falling back to the link's address.
- `resolveStoredLinkAddress` returns the target's `{ kind, uri, suffix }` once; hosts carry
  that value through lookup instead of parsing the href again.
- Href classification is shared: raw `%` is a literal manuscript path and protocol-relative
  `//host/x` is external. Callers do not reimplement relative resolution.

[handles]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/addresses.md#handles-name-owners-names-are-labels
[schemes]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/addresses.md#schemes
[links]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/links.md#stored-identity-and-spelling
