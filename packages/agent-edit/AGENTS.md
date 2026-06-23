# @meridian/agent-edit

Shared agent-editing core behind the `write(command=...)` tool surface. Built on
port interfaces (`UpdateJournal`, `DocumentCoordinator`, `Codec`,
`AgentEditModel`, `ActorSessionStore`) so the same core works for Meridian web,
desktop, MCP, and future products.

## What it is

- **Codec** — BlockCodec/MarkCodec registration atop unified/remark. Pinned
  stringify for canonical output. One per format (markdown, MDX, …).
- **Resolver** — block-hash → Y.XmlElement, `find` with exact-match + NFC,
  scope lowering (block range, section, around).
- **Apply** — 3-tier (Tier 1 Y.XmlText ops, Tier 2 per-block updateYFragment,
  Tier 3 fragment insert/delete), preflight-before-mutate discipline, echo +
  concurrent-edit detection.
- **Undo/redo** — single cold reconstruction path from the durable journal
  (checkpoint + retained update rows + mutation metadata). Forward writes keep
  a stable per-thread Yjs transaction origin symbol; reversal does not use an
  in-memory reversal cache.
- **Core surface** — `createAgentEditCore({ journal, coordinator, codec,
  model })` exposes the agent `write()` tool plus turn-level availability/user
  undo seams (`getAvailability`, `undoTurn`, `redoTurn`, `invalidateThread`).

## What it is NOT

Hocuspocus, Postgres/Drizzle, auth, HTTP/WS handlers, editor UI, TipTap
integration, or any transport or storage adapter. Those live in `apps/server`
adapters or in the MCP distribution package.

## The invariant

The Yjs CRDT machinery is generic and reusable on any `Y.Doc`: updates, cold
reconstruction from the reversal journal, idempotency, concurrent-edit
detection, and the host infra ports (`UpdateJournal`, `DocumentCoordinator`,
`DocumentLifecycle`, `ActorSessionStore`, codecs, coordinators — Hocuspocus /
in-process mutex). None of that needs ProseMirror.

The **content editing model is ProseMirror today** — the `write` command grammar
edits a block-structured markdown document represented as y-prosemirror. Making
the content model swappable so the library can edit non-ProseMirror Yjs documents
is an **intended future direction, deferred** (GH issue #70, "generic Yjs edit
core"). The seams for it exist (`Codec`, structural `AgentEditModel`) but are
not yet fully realized — the apply core still calls ProseMirror-specific
operations, so y-prosemirror is the only working implementation. Do not
over-claim it as done; do not delete the seams.

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
