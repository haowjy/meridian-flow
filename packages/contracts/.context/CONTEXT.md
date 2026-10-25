# @meridian/contracts — boundary contracts

This page records cross-package invariants that are not apparent from one
consumer. The source types remain the authority; this document explains which
contract owns a rule and where it is consumed.

## Canonical definitions

- `src/agents/execution-knobs.ts` owns resolved execution configuration, closed
  effort and permission values, tool aliases, and presence-sensitive patches.
  Compilers, invocation patches, and provider mappings project this shape; they
  must not redeclare its value sets.
- `src/threads/` owns pending placeholder roles and `ControlBody`
  (`compact`, `write_mode`), while `src/works/ai-write-mode.ts` owns the
  write-mode values (`direct`, `draft`). Database partial indexes and checks
  (inbox body and the `ai_write_mode` columns in `schema/agent-threads.ts` and
  `schema/content.ts`), websocket schemas, route schemas, and projections that
  pick kinds by name (runtime `run-state.ts`, the app's
  `features/chat/thread-controls/thread-controls.ts`) must change with those
  unions; a missing kind or mode fails its enqueue or drops the queued item.
- `threads/run-state.ts` owns the `RunState` record, carried whole on
  `liveState.runState`, the socket's `subscribed` state, `meridian.run_state`
  frames and every command answer (`runState`); only admission carries a bare
  `runStateVersion`. `protocol/run-boundary.ts` is the single reader for the
  frames and the write-once run identity a turn carries
  (`Turn.executionId`/`reservedForUserTurnIds`/`delivery`/`position`).
  Consumers order an execution's turns by `position`.
- Durable trail contracts stay lifecycle-neutral. Receiving-writer attention is
  computed per connection as `ChangeEventProjection.swept`, a best-effort
  live-session hint that never enters `TrailChangeV1` or persisted projections.
- `src/deletion-retention.ts` owns deletion retention timing used by server jobs and
  UI countdowns.
- `protocol/document-filename.ts` parses writer names. Prose uses an empty
  extension and markdown filetype; registered binary suffixes remain lowercase
  extensions, while unknown suffixes stay in the name. Storage suffix selection
  is separate and receives parsed parts explicitly. Identity parsing never
  depends on storage kind: there is no separate binary identity mode and no
  display key (stored parts already render the writer and model name). Move and
  copy pass the source extension explicitly, never infer it from filetype.
- Yjs protocol contracts expose only live rooms and stable-identity draft
  rooms (`draft:<draftId>`, no generation). Every close pair a classifier uses lives in `WS_CLOSE`; transport-local
  lifecycle closes stay with their emitting transport.

## Context ownership and URIs

`context-uri.ts` owns scheme classification and address syntax. Draft-mode
Works own manuscript, KB, user, and unfiled content; Scratch and uploads are
not drafted. A leading `@` in each path segment is reserved for owner authority;
other `@` characters are valid. `uploads://@c15/x` names a chat's upload
(`{ kind: "chat" }`); a bare `@`, a name, an uppercase handle and a subagent handle
(`p…`) are refused for uploads, each with its own correction (`handles.ts` classifies
the token). Bare `uploads://x` and `scratch://x` remain
contextual.

`ContextOwner` is either `workId` or, for Scratch, `rootThreadId`; never both.
A resolved catalog owner carries that identity and its lineage handle from the
address snapshot. Flatten it to `workId` or `rootThreadId` only at HTTP and
storage edges. `formatParsedContextUri` formats syntax but never grants
authority; clipboard qualification uses the holder's ownership of the scheme,
and with no applicable owner the link stays contextual. `WorkHandle` proves
grammar only (`w` and digits).

The Scratch `@c12/` qualifier is a lineage owner, not a path segment: a handle
without a lineage is invalid, and href traversal and relative spelling
never cross lineage owners. `WorkingSetRoute` has the same two arms (`workId`
or `rootThreadId`). `GET .../context/lineages/:rootThreadId` names a lineage by
handle and title, trashed first chat included.

## Stored links

`document-href.ts` is the single kind-aware resolver and speller for standard
Markdown link destinations. A folder URI has no trailing slash; its href does.
Stored links are never respelt in place: they carry refs and spell on read.
`document-ref.ts` owns `doc:<uuid>`, `folder:<uuid>`, and `ahead:<uuid>` refs (only
canonical UUIDs parse), the only ahead-ref mint, the ahead-address rule, and
preservation of malformed present refs so they resolve as gone instead of
falling back to the link's address. `document-link.ts` owns written-link classification and stored-link resolution over a
host `LinkCatalog`.

`DocumentLinkAnswer` returns a live folder as
`{ state: "folder", folder: { id, name, uri } }`. An inaccessible or deleted
folder uses the same `{ state: "gone" }` answer as a document.

Addresses are decoded canonical URIs; stored `href` and `src` values are
escaped spellings. Build ref-bearing hrefs with `storedHref({ kind, uri }, suffix)`, not
string concatenation, because `#`, `?`, and `%` in filenames are data. Refs
never appear in Markdown, HTML, URIs, or model text. If a target is gone or
unreachable, spell the stored href rather than its new location.

Href classification is shared: raw `%` is a literal manuscript path and
protocol-relative `//host/x` is external. Parse and serialization callers do
not reimplement relative resolution or classify sources independently.

## Boundary shape

Keep contracts JSON-natural. `Usage.inputTokens` is inclusive of its disjoint
cache counters, so each gateway adapter normalizes provider output before
`assertValidUsage`. Asset references persist `assetDocumentId` and a
project-relative `assetPath`; signed URLs are render-time details only.
Blocks describe the writer transcript. Model-only document-text elisions belong
in compaction metadata.

## Snapshot read boundary

Thread snapshots compose the canonical `threadSchema` and `turnSchema` (including
blocks, usage and model responses). Their DTO types are inferred from the schemas;
the app and `./mf` consume the parsed result, not a widened partial check. Identity
lookups remain explicit projections and cannot stand in for full DTO validation.

Golden protocol fixtures are test-only exports at `@meridian/contracts/test-support`.
Production barrels do not re-export test data.
