# Write invariants

## Key invariants

- **Block hash = the live `Y.XmlElement`'s CRDT item ID** (assigned at element
  creation). Stable across content edits of that element, and across **neighbor**
  insert/delete shifts (insert/delete preserve relative order, so y-prosemirror's
  prefix/suffix matching leaves untouched blocks' item ids intact). Lost on type
  change or deletion (new element → new ID).

- **In-place block reorder is NOT a supported operation — by policy.** y-prosemirror
  reconciles a same-order-breaking change (a drag/move) by *position*: it keeps each
  item id pinned to its slot and **rewrites content in place**, so a "moved" block
  would land on a different item id and its hash would silently re-bind to whatever
  content shifted into that slot. We therefore do **not** expose drag-to-reorder for
  text blocks (paragraph/heading carry no `draggable`). **Any future move feature
  MUST be implemented as delete-old + insert-new (copy-paste semantics)** — the
  moved block gets a fresh identity, and the hash model stays "item id = stable block
  identity" for every supported edit. Do not wire a node's `draggable`/default DnD to
  reposition blocks; that reintroduces the in-place rebind.
  - `MeridianFigure`'s `draggable` was removed (here + `packages/prosemirror-schema`)
    for this reason; figures move via cut/paste. Drag-to-place is a wanted feature,
    to be built as delete+insert — see issue #111 / `apps/app/src/core/editor/.context/TODO.md`.

### Destructive scoped replace/delete wrong-target residual

Scope addresses are view-scoped; durable identity is the full CRDT item hash and
its content. A stale no-`find` destructive replace/delete scoped by hash, numeric
index, range, or section can resolve to a different current block after
concurrent edits, and without content confirmation the target cannot be verified.
Mitigations are layered: `find`-based replace is content-backstopped;
no-`find` destructive scoped replace/delete is staleness-gated and asks for a
re-read when the doc changed since the last read; any remaining wrong-target is
visible in the op echo and recoverable through undo lineage.

- **Markup round-trip stability.** Arbitrary markdown/MDX normalizes on first
  parse. Repeated serialize → parse cycles produce identical output.
- **Public mutations stay at turn/tool seams.** Low-level mutators
  (`applyTextEdit`, `insertBlocks`, etc.) are not exported from the package
  root; callers mutate through `write()` or the write-level undo/redo seams.
- **Coordinator/runtime failures → `internal_error`**, not
  `document_not_found`. Only document-missing from the coordinator is
  `document_not_found`.
- **Turn identity is durable.** Reversal groups rows by journal mutation
  metadata, so restart/recovery does not depend on live in-memory undo state.

### Sync engine — the write loop

How the runtime doc, the live doc, and the response buffer stay reconciled. Each
rule below blocks a specific failure: silent document corruption, or the agent
going blind to a concurrent human edit.

- **Offline-peer model.** The model never edits the live doc. It edits a
  per-session **runtime Y.Doc**; the live doc is canonical (source of truth). All
  reconciliation is Yjs CRDT merge — never last-writer-wins or conflict resolution.
- **V_sync is the write gate.** `session.documents[docId].stateVector` ("what the
  runtime has seen") is set by `markSynced` on read / create / write / commit. A
  mutating write requires a prior sync (`requireSynced`); when the runtime replica
  is missing or the live doc is stale, `requireSynced` transparently cold-rebuilds
  from canonical rather than forcing the model to `read` — a read is never
  *required* to edit. Only a genuinely missing document errors. Staleness of the
  shared live doc (journal updates not yet replayed) is tracked by `staleLiveDocs`
  in `runtime-store.ts`; it is doc-scoped, not thread-scoped, and is not a hot
  cache.
- **Runtime sync state is memory-only and not an attribution source.**
  `session.documents[docId]` keeps only the current state vector (`V_sync`) while
  a process/session is live; nothing in that map is persisted. Attribution/echo
  baselines are cold-derived per interaction from durable pull-time primitives
  (thread-peer branch state plus journal floor) and passed through the write
  context. If a standalone package caller lacks that host baseline, detection
  falls back only to the current write's request-local pre-own snapshot;
  session-lifetime memory is never a concurrent-attribution baseline.
- **One attribution path for warm and cold processes.** A live process and a
  restarted process use the same interaction baseline inputs. Response-aware attribution may
  integrate earlier same-response buffered updates into that baseline, and may
  degrade to the current write's request-local `preOwnSnapshot` when Yjs cannot
  integrate the staged delete-set shape into the colder baseline. It must not read
  any session-lifetime full-document snapshot as a next-interaction baseline.
- **`read` is a self-healing reconstruction, not a merge.** Every `read` discards
  the runtime, rebuilds from canonical (live), and replays pending buffered updates:
  `runtime = canonical ⊕ replay(pending)`. It never trusts accumulated local state,
  so `read` can never carry runtime drift forward or corrupt the doc. At turn start
  (no pending) it is exactly canonical. The reversal path uses the delta merge
  `syncLocalFromLive`; `read` does not.
- **`read` and `find` read the same doc.** Both resolve against the runtime, so the
  model can always `find` what `read` showed it. This is *why* `read` replays
  pending: otherwise a write after a mid-response `read` could re-match
  already-edited text and self-mangle at commit.
- **Write lifecycle.** `mutate local → merge local→live → re-sync live→local →
  advance V_sync → emit echo`; the echo's concurrent set = blocks the re-sync
  touched. Deferred commit collapses **only** the merge+re-sync to once per turn
  (N writes → 1); each buffered write already emitted its per-write echo before
  commit.
- **Echoes are one per-write function.** `computeEcho(before, after, touched,
  deleted)` expands a ±1 window around the agent-touched/deleted hashes and tiers
  each surviving post-write block independently: inserted or serialized-content
  changed from `v_pre` to `v_post` → full `hash|content`; identical context →
  first ~8 words plus `...`; outside the window → omitted. Concurrent overlap and
  structural changes are not separate modes.
- **Echoed text is verbatim, because the model targets it.** Every character an
  echo shows must resolve through the exact matcher, so the echo path normalizes
  nothing — no whitespace collapsing, no tab/NBSP folding. Truncation may drop a
  suffix but never rewrites the prefix it keeps. The tempting `\s+ → " "` cleanup
  reads as cosmetic and is not: find-all deletion legitimately leaves double
  spaces, and an agent retrying with what it was just shown then fails
  deterministically (#383). Block framing is the open counterpart — multi-line
  bodies still break the `hash|body` line grammar (#409).
- **Tool results use two content blocks.** Successful writes and undo/redo
  return metadata in block 1 (`status`, write id or reversal count, concurrent
  edits) and echo `hash|content` lines in block 2 when there are echo lines.
  Hosts should prefer structured `content` over the joined `text`.
- **Mangled-but-intact.** Two edits to the same span CRDT-merge at character level
  → garbled but never lost. The model is **told** via the echo, never prevented.
  Whole-document overwrite preserves this behavior for positional same-type
  counterparts, including complex blocks. Shrinking deletes unmatched parents,
  and shrink plus a block-type change can still lose all concurrent text nested
  under those parents; canonical-advancement reject/replan owns that residual
  window.
- **Commit re-sync is a delta+origin apply, not a rebuild.** It applies concurrent
  updates one at a time, attributing each touched block to human vs agent by
  persisted origin (the update bytes don't carry it). `read`'s rebuild can't
  attribute, so it is not used for the commit re-sync.
- **Sequential tool dispatch is load-bearing.** The host dispatches tool calls one
  at a time; writes apply to the runtime sequentially, so overlapping *self*-writes
  compose or `no_match` rather than self-mangle. Parallelizing the dispatch
  (`Promise.all`) would let two writes resolve against the same snapshot and
  self-mangle at commit.
- **The response buffer is the commit source, not the runtime doc.** The
  runtime is a scratchpad (find resolution + rendering). Commit applies the buffer
  to live exactly once; `read`'s replay touches only the runtime and never
  double-commits.
- **`find` matching happens in serialized markdown space.** When a matched block
  body is identical to flat editable text and the payload is plain text, same-block
  matches lower to exact text spans (`text` for one match, `textRanges` for several).
  All formatted, escaped, entity, and cross-block cases splice and parse the
  affected serialized range before `replaceScope(...)`; they must not use
  serialized-body→flat offset mapping.
