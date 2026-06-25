# agent-edit — contracts, architecture, invariants

## Port interfaces

### UpdateJournal / ReversalStore (`src/ports/update-journal.ts`)
The persistence seam is split by concern:

- `UpdateJournal` is the ordered Yjs update log: append, `appendBatch`, live-load
  `read`, checkpoint, and compact.
- `ReversalStore` owns write-level reversal state: write ordinal reservation,
  active/reversed write metadata queries, `readForReconstruction(docId)`,
  per-handle `mutationsForWrite` and the batch `mutationsForWrites` (one query for
  multiple handles), `persistUndo`, `persistRedo`, and `readReversals`.

`readForReconstruction` is the domain-level retained-log read used by cold
undo/redo so checkpoint mechanics stay adapter-local; reversal code no longer
passes `read(..., { fromCheckpoint: false })` through the generic log port.
Adapters may implement both interfaces in one class when the update log,
mutation rows, and reversal rows are co-sourced (Drizzle and the in-memory test
journal do).

Response staging still commits document updates through `UpdateJournal.appendBatch`.
Forward write mutation entries reserve a per-thread `w<N>` ordinal through
`ReversalStore.reserveWriteOrdinal`; undo/redo selection and availability then
use the same store to plan against retained update rows and mutation metadata.
Grouped redo is keyed by the durable `undoUpdateSeq`: redo discovery returns the
whole group, and `persistRedo` reactivates every write handle in that group
atomically.

### DocumentCoordinator (`src/ports/document-coordinator.ts`)
Exclusive access to a live Y.Doc. `withDocument(docId, fn)` serializes callers
for the same docId (KeyedMutex on server, process-level lock on desktop).
`recover(docId)` replays persisted-but-unapplied updates on startup. Rejects
`DocumentNotFoundError` when the doc is missing.

### DocumentLifecycle (`src/ports/document-lifecycle.ts`)
Deployment-owned document creation seam. `ensureDocument(docId)` idempotently
brings a live document into existence so `DocumentCoordinator.withDocument(docId)`
can subsequently grant exclusive access. It must create only when missing and
must not clobber existing content. The package keeps the contract generic:
plain `docId: string`, no auth, URI schemes, storage, or collaboration-server
types. `write(command="create")` requires this optional port; deployments that
do not support creation get `invalid_write` instead of a thrown not-found.

### Codec (`src/codec/types.ts` — interface, `src/codec/create-codec.ts` — assembly)
Composed from BlockCodec (one per PM block node type) + MarkCodec (one per PM
inline mark). Layers on unified/remark: unified owns parse/stringify, the codec
owns the PM-mapping dispatch. `serialize`/`parse` are the two directions; the
per-block render path is `serializeBlock` (with hash prefix), or the batch
`serializeBlocks` which allocates one unified runtime for all hash-prefixed
blocks. Resolver/find code uses `serializeBlockBodies` for the same block-body
normalization without hash prefixes; callers should not reimplement trailing
newline or empty-paragraph normalization.
Pinned unified stringify options for canonical round-trip output. Concrete:
`presets/markdown.ts`, `presets/mdx.ts`. Codec factories require the host's
ProseMirror `Schema`; the package has no default Meridian schema.
`@meridian/prosemirror-schema` is a devDependency only — host composition passes
the schema explicitly. This keeps the package provably host-agnostic without
server/infra dependency leaks. See `src/codec/create-codec.ts:29`.

### AgentEditModel (`src/ports/model.ts` — port, `src/model/y-prosemirror.js` — v1 impl)
Structural model port for what "block" means in Yjs. Carries the 3-tier apply
implementation: `getBlocks`, `getBlockId` (hash from CRDT item ID), `getText`,
`applyTextEdit` (Tier 1/2), `insertBlocks` (Tier 3), `deleteBlock` (Tier 3), plus
the current ProseMirror projection hooks `toProsemirrorBlock` and `applyBlockDiff`.
v1 is y-prosemirror only. `yProsemirrorModel(schema)` is explicit; the server
composition root supplies Meridian's fiction schema. Hosts depend on the
structural `AgentEditModel` port, not the concrete y-prosemirror model type.

### Batch paths — preferred for multi-block operations

The per-block helpers each re-scan the **whole document block list** to produce
one block's result, so a per-block loop is **O(B²)**, not O(B):

- `getBlockId(block)` resolves a unique hash against *all sibling blocks* (re-sorts and re-hashes every sibling per call).
- `toProsemirrorBlock(doc, block)` rebuilds the *entire ProseMirror tree* (O(D)) to project one block.
- `Codec.serializeBlock` allocates its own unified runtime per block.

Every batched write touches all of these (snapshot, render, find) plus once per
staged write in `postCommitEchoes`. **Use the batch path for any multi-block op:**

| Batch | Replaces (do not loop) | Does once |
|---|---|---|
| `projectDocumentBlocks(doc, model)` | ad hoc `getBlocks` + `getBlockIds` + `toProsemirrorBlocks` + index maps in render/find/echo paths | aligned full-document block/hash/PM projection |
| `getBlockIds(doc)` | per-block `getBlockId` for document order | sort + unique-hash all blocks |
| `toProsemirrorBlocks(doc)` | per-block `toProsemirrorBlock` | project the PM tree |
| `serializeBlocks(blocks, hashes)` | per-block `serializeBlock` | allocate one unified runtime |
| `serializeBlockBodies(blocks)` | ad hoc `serialize([block])` + newline/sentinel cleanup | hashless block-body normalization |
| `blockHashesForDoc(doc)` / `uniqueHashesForBlocks` | per-block `getBlockHash` | the sorted unique-hash pass |
| `ReversalStore.mutationsForWrites(docId, threadId, handles)` | per-handle `mutationsForWrite` | one query |

Callers already on the batch path: `snapshotBlocks` (`apply/echo.ts`),
`renderBlockLines` / `renderOutline` (`tool/document-renderer.ts`),
`serializeScopeBlocks` (`resolver/find.ts`), `lookupBlockHash`
(`resolver/block-hash.ts`), `afterSnapshot` precompute
(`tool/mutation-commit.ts`), and `postCommitEchoes` memoizes one snapshot per
response (`tool/response-staging.ts`). The Drizzle journal adapter commits a
staged response in one multi-row INSERT via `appendBatch` (per-update
`appendMutation` was deleted). The in-memory test journal implements the same
batch API. See the [performance reference][perf] for measured numbers.

[perf]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/agent-edit-performance.md

### ActorSessionStore (`src/ports/actor-session-store.ts`)
Stable identity for external callers. Maps transport-level IDs to persistent
sessions that survive reconnects. The core library operates on `ActorSession`
only. Optional — falls back to a local in-memory map when omitted.

### AgentEditCore (`src/index.ts`)
The public package façade exposes `write()`, `recover()`,
`commitResponse(responseId)`, `rollbackResponse(responseId)`,
`getAvailability(docId, threadId)`, `undo(docId, threadId)`,
`redo(docId, threadId)`, and `invalidateThread(docId, threadId)`; `undoTurn` and
`redoTurn` remain host-compatible aliases. Host
runtimes that pass `WriteContext.responseId` must call exactly one of the
response lifecycle methods after the model response finishes or is cancelled.
`getAvailability` is the source of truth for whether write-level undo/redo will
attempt work: undo requires active mutation metadata plus the retained earliest
forward row for that turn; redo requires a retained reversed record/update, the
retained earliest forward row for the reversed turn, and the existing linear-redo
eligibility check. `invalidateThread` evicts cached runtime state and staged
response buffers for a document/thread so the next access rebuilds runtime state
from the live document and journal.

## Architecture

### Codec pipeline
```
source string → unified parser → mdast → BlockCodec dispatch → MarkCodec dispatch → PM nodes
PM nodes → BlockCodec.serialize → MarkCodec.serialize → mdast → unified stringify → source string
```
Block hash prefix added by `serializeBlock()` at render time (not stored as
attribute). Hash derived from Y.XmlElement CRDT item ID (`clientID + clock`).

### 3-tier apply (`src/apply/tiers.ts`)
Preflight-before-mutate discipline: Phase 1 (read-only) validates all
references, parses content, computes offsets, checks Tier 1 eligibility.
Phase 2 (inside `doc.transact()`) applies pre-computed operations.

| Tier | Kind | Mechanism |
|---|---|---|
| 1 | `text` with same-mark span | Direct Y.XmlText delete + insert |
| 2 | `text` crosses mark boundary or formatting change | Per-block updateYFragment |
| 3 | `insert` / `delete` | Fragment-level Y.XmlElement insert/delete |

Last-block edge case: deleting the only remaining block clears text instead of
structurally deleting (preserves ProseMirror `doc(block+)` invariant).

### Undo/redo (`src/undo/`)

Reversal is a single cold reconstruction path from `UpdateJournal`. It replays
the retained durable update log (plus only a seq-0 baseline checkpoint when the
host initialized a document that way), assigns per-reconstruction `Symbol` tokens,
creates a fresh local `Y.UndoManager`, tags only the requested target forward
update seqs with the tracked token, runs undo/redo, and extracts update bytes.
The target seqs come from mutation rows: undo targets currently `active` rows for
the turn; redo targets `reversed` rows whose `undoUpdateSeq` matches the redo
target. This journal-backed model is authoritative.

Forward agent writes still use a stable transaction origin `Symbol` per
`(docId, threadId)` pair via `ThreadOriginRegistry`. That origin is for Yjs
transaction attribution and same-actor filtering only; write selection for
reversal comes from durable journal metadata (`w<N>` / mutation row
`createdSeq`; `turnId` remains context), not live undo stack items.

Redo targets are selected from durable `ReversalRecord` rows with
`status: "reversed"`; there is no runtime redo stack or rehydration cache. Redo
consumption is authoritative at persist time: `persistRedo()` rechecks the
doc+thread+turn reversal is still `status: "reversed"` inside the append
transaction, marks it `status: "redone"`, and returns `consumed: false` without
appending when another session already used it.

**Write-level undo:** each `write()` call is its own durable mutation row. Undoing without a selector reverses exactly the latest active write. Each write has a stable per-(document, thread) handle (`w1`, `w2`, …) stored on mutation metadata and never renumbered. `undo`/`redo` can target `{to:"w3"}`, an inclusive `{from:"w2", to:"w5"}` range, `{last:N}`, or `{all:true}`. Range reconstruction still uses Yjs UndoManager item identity: selected writes are tracked, non-selected/concurrent updates replay untracked, so same-area concurrent merge behavior is unchanged.

## Key invariants

- **Block hash stable under edits.** Derived from CRDT item ID (assigned at
  element creation). Survives content edits, position shifts, reordering.
  Lost on type change or deletion (new element → new ID).
- **Codec round-trip stability.** Arbitrary markdown/MDX normalizes on first
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

How the runtime doc, the live doc, and the staging buffer stay reconciled. Each
rule below blocks a specific failure: silent document corruption, or the agent
going blind to a concurrent human edit.

- **Offline-peer model.** The model never edits the live doc. It edits a
  per-session **runtime Y.Doc**; the live doc is canonical (source of truth). All
  reconciliation is Yjs CRDT merge — never last-writer-wins or conflict resolution.
- **V_sync is the write gate.** `session.documents[docId].stateVector` ("what the
  runtime has seen") is set by `markSynced` on view / create / write / commit. A
  mutating write requires a prior sync (`requireSynced`) or returns
  `document_not_synced` ("run view").
- **`view` is a self-healing reconstruction, not a merge.** Every `view` discards
  the runtime, rebuilds from canonical (live), and replays the response's pending
  staged updates: `runtime = canonical ⊕ replay(pending)`. It never trusts
  accumulated local state, so a `view` is a read that can never carry runtime drift
  forward or corrupt the doc. At turn start (no pending) it is exactly canonical.
  The reversal path still uses the delta merge `syncLocalFromLive`; `view` does not.
- **`view` and `find` read the same doc.** Both resolve against the runtime, so the
  model can always `find` what `view` showed it. This is *why* `view` replays
  pending: otherwise a write after a mid-response `view` could re-match
  already-edited text and self-mangle at commit.
- **Write lifecycle.** `mutate local → merge local→live → re-sync live→local →
  advance V_sync → emit echo`; the echo's concurrent set = blocks the re-sync
  touched. Deferred commit collapses **only** the merge+re-sync to once per turn
  (N writes → 1) and must still emit that echo.
- **Echoes are per-write, computed from the post-re-sync snapshot.** Even batched,
  each staged write echoes via `computeEcho`'s adaptive tiers (suppress / truncated
  / full) against the single post-re-sync snapshot — observationally identical to
  applying the writes one at a time. Each block appears at most once across the
  combined echo (dedup), in write order.
- **Mangled-but-intact.** Two edits to the same span CRDT-merge at character level
  → garbled but never lost. The model is **told** via the echo, never prevented.
- **Commit re-sync is a delta+origin apply, not a rebuild.** It applies concurrent
  updates one at a time, attributing each touched block to human vs agent by
  persisted origin (the update bytes don't carry it). `view`'s rebuild can't
  attribute, so it is not used for the commit re-sync.
- **Sequential tool dispatch is load-bearing.** The host dispatches tool calls one
  at a time; writes apply to the runtime sequentially, so overlapping *self*-writes
  compose or `no_match` rather than self-mangle. Parallelizing the dispatch
  (`Promise.all`) would let two writes resolve against the same snapshot and
  self-mangle at commit.
- **The staging buffer is the durable commit source, not the runtime doc.** The
  runtime is a scratchpad (find resolution + rendering). Commit applies the buffer
  to live exactly once; `view`'s replay touches only the runtime and never
  double-commits.
- **`find` reconciliation happens in serialized markdown space.** Matches resolve to
  serialized block ranges. The resolver splices the requested replacement into the
  markdown source, parses that affected range, and lowers through `replaceScope(...)`
  so single-block and cross-block finds share the same parse+diff path. A narrow
  Tier-1 fast path is allowed only when the matched block body is already identical
  to flat editable text and the replacement is plain text; formatted/escaped/entity
  cases must not use serialized-body→flat offset mapping.

## Tool surface

`write()` returns a structured `WriteOutcome { command, status, isError, text }`
(`src/tool/types.ts:94`). The host routing layer reads the structured envelope;
the LLM-facing response is the plain `text` field (status line + echo + content).
`idempotency` is provided by `tool_use_id` — replay returns the cached text.

**Response staging:** callers can pass `WriteContext.responseId` to stage
`create` / `insert` / `replace` writes for one model response. Each write applies
immediately to the agent runtime doc and returns an echo from that cumulative
staged state. Journal append, live-doc sync, concurrent-edit merge, and
projection refresh are deferred to `commitResponse(responseId)`, which appends
the buffered updates in one journal batch and then applies one aggregate Yjs
update per document. Journal batch failure leaves the buffer retryable and
invalidates staged runtimes so ordinary later views do not see phantom edits. If
the journal batch lands, the whole response is durable and remains the latest
undoable turn even when the post-commit live projection fails. In that case
`commitResponse(responseId)` recovers live docs from the journal, rebuilds and
reattaches the affected runtimes, and returns success; only a recovery failure
invalidates runtimes so next access rebuilds from journal truth.
`rollbackResponse(responseId)` is cancellation for uncommitted buffers: it
discards staged updates and restores affected runtime docs from live. If called
after a journaled commit attempt, it is recover-only.

**Deferred commit must complete the merge+sync lifecycle.** Staging is an
optimization: instead of merge+re-sync per write, a response's writes batch into
**one** lifecycle run at `commitResponse` (N writes → 1 merge+sync). Only the
merge+re-sync is collapsed. After that single re-sync, the package computes the
post-commit echo for each staged write, in original write order, using that
write's pre-write snapshot and touched/deleted hash metadata against the one
post-re-sync runtime snapshot. Suppressed per-write echoes are omitted; structural
writes still produce truncated echoes even without concurrent edits; concurrent
overlap at the write site produces a full echo. `documents[*].concurrentEdits` is
the document-level human/agent touched-hash summary from the one re-sync and keeps
the collapse-threshold behavior. The garbled character-level merge of two edits
to the same text is accepted ("mangled-but-intact") — the model is told via this
echo, not prevented. Mid-response, per-write echoes reflect the local runtime
(there is no per-write re-sync to live) — the accepted cost of the optimization,
not a defect. An explicit `view` still reconstructs from canonical (see the
sync-engine invariants), so the model can re-ground on live truth on demand.

Without `responseId`, writes keep the immediate append + live sync behavior.
`undo` / `redo` are not staged; if a response buffer exists when undo/redo runs,
the buffer is committed first so reversal order matches tool-call order.
`commitResponse()` and `rollbackResponse()` also report staged-create outcomes
for hosts that created path-level placeholders before the journal commit:
committed creates must keep their path, while only pre-commit discards should be
deleted. `invalidateThread()` marks pending staged creates as discarded inside
the response buffer so a later empty commit still carries the cleanup signal.

**`documentId` vs `file` / `filePath`:** The model-visible schema uses a
human-readable path (for Meridian, a context URI such as `work://chapter-2.md`).
The host resolves that path to an internal `documentId` and passes both into the
package. `documentId` is only storage/journal/runtime/coordinator identity;
model-facing text must render the display `file` / `filePath`, including view
commands, creation guidance, not-found messages, and re-sync hints. The package
stays host-agnostic: it does not invent display paths, it only echoes the path
the host supplied. Tests should prefer UUID-like document ids plus friendly
paths so accidental UUID interpolation fails loudly.

## v1 simplifications (deferred, documented for discoverability)

- **Tool versioning** deferred (GH issue #68). Seam kept clean — pure
  resolvers, stable `ResolvedEdit`, version-agnostic apply layer. No version
  pinning until a v2 exists.
- **View auto-budget/truncation** deferred. Current `view` returns full
  content. Thread-level context management is not yet implemented.
- **Generic concurrent attribution** deferred to server adapter. `concurrent
  edits` reports `human` vs `agent` categories; no individual actor names.
- **Multi-document turn reversal** not yet implemented. Each document's
  undo runs independently; no turn-level coordination across documents.
- **Cross-block `find`** (find string containing `\n\n`) supported via
  structural lowering in the resolver. Routes to Tier 2+3.

## Testing

Package tests cover block-hash stability, codec round-trip, resolver with
cross-block find, 3-tier apply preflight + edge cases, echo computation, cold
undo/redo reconstruction (including the 8-case reconcile matrix, subset redo,
drift invariants, availability, and public turn seams), response
staging/recovery, and create lifecycle.

### Write handles and selective reversal

Every successful mutating write returns a short handle line (`write id: w<N>`) even when its echo is otherwise suppressed. The ordinal is allocated per `(document, thread)`, persisted on the mutation row, and never reused or renumbered by undo/redo. `WriteContext.tool_use_id` remains the durable idempotency id in mutation metadata; `w<N>` is the model-facing range key.

Post-commit response echoes label emitted hunks with the write handle (`w3: …`) so concurrent/reconciliation reports can be traced back to the write to undo. Suppressed echoes stay suppressed.

Undo/redo defaults to the latest write. The command surface also accepts one write (`to`), inclusive ranges (`from` + `to`), newest N (`last`), or all (`all`). The cold reconstruction algorithm is unchanged except that its selected target is a set of write seqs rather than one turn id; non-selected and concurrent updates still replay untracked through Yjs UndoManager, preserving same-area merge behavior.
