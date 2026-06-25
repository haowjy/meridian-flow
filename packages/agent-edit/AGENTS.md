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
  model })` exposes the agent `write()` tool plus write-level availability/user
  undo seams (`getAvailability`, `undo`, `redo`, `invalidateThread`; `undoTurn`/`redoTurn` remain host-compatible aliases and default to the latest write).

## Mental model: offline peer, one merge+sync lifecycle per turn

The model does not edit the live document directly. It edits its own per-session
**runtime Y.Doc** — an offline peer. The canonical `write` lifecycle (design of
record, `…/agent-edit-write-loop/design/interactive-design-v4.html`, "Sync model &
V_sync") is:

```
mutate local → merge local→live → re-sync live→local → advance V_sync
             → emit echo (concurrent edits = blocks touched by the re-sync)
```

"Re-sync" is a non-destructive Yjs merge (`syncLocalFromLive`): it pulls the
concurrent edits live has that the runtime lacks (other humans/agents) while
preserving the model's own edits. The character-level CRDT merge of two edits to
the same text is accepted as "mangled-but-intact" — the model is **told** about
the conflict via the concurrent-edits echo, it is not prevented.

**Deferred commit (response staging) is an optimization, not a different model.**
Instead of running the full lifecycle on every write, a response's writes are
buffered and the lifecycle runs **once** at `commitResponse` — N writes collapse
to **one** merge+sync per turn. Only the merge+sync collapses: post-commit echoes
are still computed per staged write, in order, from the single post-re-sync
snapshot using the same adaptive `computeEcho` tiers (suppressed / truncated /
full). The document-level concurrent-edits summary (`human` vs `agent`) still
comes from the one re-sync. Dropping those post-commit echoes (or aggregating them
into one blob) leaves the agent blind to concurrent edits and structural insert
context, so this package guards that contract.

**`view` is a self-healing reconstruction — it never trusts local state.** Where
the commit re-sync above is a *delta merge into* the runtime (it needs per-op
origins to attribute human-vs-agent), `view` instead **rebuilds** the runtime
from canonical (live) and replays the response's pending staged edits:
`runtime = canonical ⊕ replay(pending)`. So a `view` is a read that can never
carry runtime drift forward or corrupt the doc; at turn start (nothing pending)
it is exactly canonical. `view` and `find` therefore read the same doc — the
model always sees concurrent human edits *and* its own in-flight edits, and can
re-ground on live truth on demand. (The reversal path still uses the delta merge
`syncLocalFromLive`; `view` does not.)

**Sequential tool dispatch is part of the contract.** The host runs the model's
tool calls one at a time, so writes apply to the runtime sequentially and two
overlapping *self*-writes compose or `no_match` rather than CRDT-mangle. The
mangle is reserved for genuine *external* concurrency (human / other agent),
which the echo reports. Parallelizing the dispatch would break this.

## What it is NOT

Hocuspocus, Postgres/Drizzle, auth, HTTP/WS handlers, editor UI, TipTap
integration, or any transport or storage adapter. Those live in `apps/server`
adapters or in the MCP distribution package.

## The invariant

Model-facing text uses the host-supplied display path (`file` / `filePath`),
never the internal `documentId`. Long UUID-like document ids are storage,
journal, runtime, and coordination identity only; they must not appear in tool
responses, view commands, re-sync hints, or creation guidance shown to the
agent. Tests should prefer UUID-like internal ids with friendly paths so a leak
is obvious.

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
→ [system shape](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-edit-write-loop/design/agent-edit-system-shape.md)
→ [apply + reversal](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-edit-write-loop/design/commutative-agent-edits.md)
→ [tool contract](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-edit-write-loop/design/agent-tool-contract.md)
