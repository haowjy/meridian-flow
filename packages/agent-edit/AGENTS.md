# @meridian/agent-edit

Shared agent-editing core behind the `write(command=...)` tool surface. Built on
port interfaces (`UpdateJournal`, `DocumentCoordinator`, `AgentEditCodec`,
`AgentEditModel`, `ActorSessionStore`) so the same core works for Meridian web,
desktop, MCP, and future products.

## What it is

- **AgentEditCodec** — thin adapter over `@meridian/markup` that adds
  hash-prefixed block serialization for echo/read. Pure markdown/MDX parsing and
  serialization live in `@meridian/markup`.
- **Resolver** — block-hash → neutral `BlockRef`/`DocHandle`, `find` with exact-match + NFC,
  scope lowering (block range, section, around).
- **Apply** — 3-tier (Tier 1 Y.XmlText ops, Tier 2 per-block updateYFragment,
  Tier 3 fragment insert/delete), preflight-before-mutate discipline, echo +
  concurrent-edit detection.
- **Undo/redo** — single cold reconstruction path from the durable journal
  (checkpoint + retained update rows + mutation metadata). Forward writes keep
  a stable per-thread Yjs transaction origin symbol; reversal does not use an
  in-memory reversal cache. Hosts that need proof an undo changed live CRDT
  content call `reverse(..., { requireEffect: true })`; the core compares full
  `Y.encodeStateAsUpdate` bytes before/after so delete-set-only changes are not
  missed.
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
to **one** merge+sync per turn. Only the merge+sync collapses. Each staged write
still returns its own model-facing echo immediately from the cumulative runtime
state; commit time only reports the document-level concurrent-edits summary
(`human` vs `agent`) from the one re-sync. Commit-time per-write echo
recomputation is intentionally deleted.

**Echo has one path.** `computeEcho(before, after, touched, deleted)` expands a
±1 block window around touched/deleted hashes, then tiers each surviving
post-write block by a direct `v_pre → v_post` serialized-content comparison:
changed or inserted blocks echo full `hash|content`, identical context blocks use
word truncation (about eight words), and blocks outside the window are omitted.
Writes and undo/redo return the same two structured result blocks: metadata
(status, write id / reversal count, concurrent edits) and echo lines.

**`read` is a self-healing reconstruction — it never trusts local state.** Where
the commit re-sync above is a *delta merge into* the runtime (it needs per-op
origins to attribute human-vs-agent), `read` instead **rebuilds** the runtime
from canonical (live) and replays the response's pending staged edits:
`runtime = canonical ⊕ replay(pending)`. So a `read` is a read that can never
carry runtime drift forward or corrupt the doc; at turn start (nothing pending)
it is exactly canonical. `read` and `find` therefore read the same doc — the
model always sees concurrent human edits *and* its own in-flight edits, and can
re-ground on live truth on demand. (The reversal path still uses the delta merge
`syncLocalFromLive`; `read` does not.)

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
responses, read commands, re-sync hints, or creation guidance shown to the
agent. Tests should prefer UUID-like internal ids with friendly paths so a leak
is obvious.

The Yjs CRDT machinery is generic and reusable on any `Y.Doc`: updates, cold
reconstruction from the reversal journal, idempotency, concurrent-edit
detection, and the host infra ports (`UpdateJournal`, `DocumentCoordinator`,
`DocumentLifecycle`, `ActorSessionStore`, codecs, coordinators — Hocuspocus /
in-process mutex). None of that needs ProseMirror.

Restart reconcile has one durable baseline: the persisted `committedSnapshot`.
Never synthesize it while reconciling; see [`.context/CONTEXT.md`](.context/CONTEXT.md).

The **kernel is CRDT-neutral, not ProseMirror-neutral**. Resolver/apply carry
opaque `DocHandle`/`BlockRef` handles; Yjs mechanics stay behind the model
adapter and runtime/undo plumbing. ProseMirror remains the codec's content
currency: `codec-types.ts` defines `Block` as `PMNode`, `ParsedContent` transits
the kernel, and resolver code still inspects PM block shape (`type.name`,
`isTextblock`, heading level, serialized bodies). Making the content model
swappable is an **intended future direction, deferred** (see
[`.context/TODO.md`](.context/TODO.md)); do not over-claim it as done, and do
not delete the seams.

## Multi-block reads use the batch helpers

`snapshotBlocks`, `renderBlockLines`, `serializeScopeBlocks`, `lookupBlockHash`,
and the per-staged-write echo all walk the document block list. The per-block helpers (`getBlockId`, single-block projection/serialization) each
re-scan all siblings, rebuild the whole ProseMirror tree, or do per-block
serialization work, so a per-block loop is O(B²) — on large chapters this is the
dominant cost. Use the batch path (model `projectBlocks`,
`serializeBlockLines`, `serializeBlockBodies`, `getDocumentBlockIds`, and
`blockHashesForDoc` inside the adapter) which does the document-wide
projection/stringify work once.
See [`.context/CONTEXT.md`](.context/CONTEXT.md) and the [performance
reference][perf].

[perf]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/agent-edit-performance.md

## v1 scope

y-prosemirror document model only. Agent-edit depends on `@meridian/markup`
for MDX/markdown codecs and wraps a host-built `MarkupCodec` with
`createAgentEditCodec(markupCodec)`. Schema injection remains explicit:
markup codec factories require the host's ProseMirror schema;
`@meridian/prosemirror-schema` is a devDependency only. Meridian server composes
the package with the fiction schema from `@meridian/prosemirror-schema`.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts, architecture, invariants.
→ [system shape](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-edit-write-loop/design/agent-edit-system-shape.md)
→ [apply + reversal](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-edit-write-loop/design/commutative-agent-edits.md)
→ [tool contract](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-edit-write-loop/design/agent-tool-contract.md)
