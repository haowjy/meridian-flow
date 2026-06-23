# @meridian/agent-edit

Shared agent-editing core behind the `write(command=...)` tool surface. Built on
port interfaces (`UpdateJournal`, `DocumentCoordinator`, `Codec`,
`DocumentModel`, `ActorSessionStore`) so the same core works for Meridian web,
desktop, MCP, and future products.

## What it is

- **Codec** — BlockCodec/MarkCodec registration atop unified/remark. Pinned
  stringify for canonical output. One per format (markdown, MDX, …).
- **Resolver** — block-hash → Y.XmlElement, `find` with exact-match + NFC,
  scope lowering (block range, section, around).
- **Apply** — 3-tier (Tier 1 Y.XmlText ops, Tier 2 per-block updateYFragment,
  Tier 3 fragment insert/delete), preflight-before-mutate discipline, echo +
  concurrent-edit detection.
- **Undo/redo** — hot path (live UndoManager per thread, stable origin symbol,
  `stopCapturing` at turn boundaries) + cold path (reconstruction from journal,
  per-turn tokens, authoritative). Hot/cold parity enforced by tests.
- **Compaction** — fold old updates into checkpoint, expire reversal records.
  Runs on first document load.
- **Tool surface** — `createAgentEditCore({ journal, coordinator, codec, model })`
  exposes `write()` as the only public mutation entry point.

## What it is NOT

Hocuspocus, Postgres/Drizzle, auth, HTTP/WS handlers, editor UI, TipTap
integration, or any transport or storage adapter. Those live in `apps/server`
adapters or in the MCP distribution package.

## The invariant

Every deployment implements `UpdateJournal`. Everything else is pluggable:
different codecs, different document models (y-prosemirror, plain Y.Text),
different coordinators (Hocuspocus, in-process mutex), different
`ActorSessionStore` implementations.

## v1 scope

y-prosemirror document model only. MDX and markdown codecs built in. Schema
injection is explicit: `createCodec({ schema })` requires the host's ProseMirror
schema; `@meridian/prosemirror-schema` is a devDependency only.
Meridian server composes the package with the fiction schema from
`@meridian/prosemirror-schema`.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts, architecture, invariants.
→ [system shape](https://github.com/haowjy/meridian-flow-docs/blob/main/work/verify-reversal-e2e/design/agent-edit-system-shape.md)
→ [apply + reversal](https://github.com/haowjy/meridian-flow-docs/blob/main/work/verify-reversal-e2e/design/commutative-agent-edits.md)
→ [tool contract](https://github.com/haowjy/meridian-flow-docs/blob/main/work/verify-reversal-e2e/design/agent-tool-contract.md)
