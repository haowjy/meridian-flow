# agent-edit — contracts, architecture, invariants

## Port interfaces

### UpdateJournal / ReversalStore (`src/ports/update-journal.ts`)
The persistence seam is split by concern:

- `UpdateJournal` is the ordered Yjs update log: append, `appendBatch`, live-load
  `read`, checkpoint, and compact.
- `ReversalStore` owns reversal state: write ordinal reservation,
  active/reversed write metadata queries, `readForReconstruction(docId)`,
  per-handle `mutationsForWrite` and the batch `mutationsForWrites` (one query for
  multiple handles), `persistUndo`, `persistRedo`, and `readReversals`.

`readForReconstruction` is the retained-log read used by cold undo/redo;
checkpoint mechanics stay adapter-local. Reversal code no longer passes
`read(..., { fromCheckpoint: false })` through the generic update-log port.
Adapters may implement both interfaces in one class when the update log,
mutation rows, and reversal rows are co-sourced (Drizzle and the in-memory test
journal do).

Response staging still commits document updates through `UpdateJournal.appendBatch`.
Forward write mutation entries reserve a per-thread `w<N>` ordinal through
`ReversalStore.reserveWriteOrdinal`; undo/redo selection and availability then
use the same store to plan against retained update rows and mutation metadata.
Grouped redo is keyed by the durable `undoUpdateSeq`: redo discovery returns the
whole group, and `persistRedo` reactivates every write handle in that group
atomically. Reversal rows also carry `redoUpdateSeq` while `status: "redone"`;
`persistRedo` sets it to the redo update seq for every row in the group, and
`persistUndo` clears it when the same write enters a new undo cycle.

### DocumentCoordinator (`src/ports/document-coordinator.ts`)
Exclusive access to a live Y.Doc. `withDocument(docId, fn)` serializes callers
for the same docId (KeyedMutex on server, process-level lock on desktop).
`recover(docId)` replays persisted-but-unapplied updates on startup. Rejects
`DocumentNotFoundError` when the doc is missing.

### UndoNotificationPort (`src/tool/write-reversal.ts`)
Optional host callback for user-triggered reversal delivery. Agent-edit passes
`threadId`, `docId`, a representative `turnId`, write handles, direction, and
`writeHandleTurns` (the per-handle turn mapping) after a successful user-actor
undo/redo persist; hosts resolve `docId` to any product URI outside the package.
Agent-actor reversals and hosts without the port keep the old behavior.

### DocumentLifecycle (`src/ports/document-lifecycle.ts`)
Deployment-owned document creation seam. `ensureDocument(docId)` idempotently
brings a live document into existence so `DocumentCoordinator.withDocument(docId)`
can subsequently grant exclusive access. It must create only when missing and
must not clobber existing content. The package keeps the contract generic:
plain `docId: string`, no auth, URI schemes, storage, or collaboration-server
types. `write(command="create")` requires this optional port; deployments that
do not support creation get `invalid_write` instead of a thrown not-found.

### AgentEditCodec (`src/codec-adapter.ts` — hash-prefixed adapter)
Agent-edit consumes an `AgentEditCodec`: a thin wrapper around
`@meridian/markup`'s `MarkupCodec`. `parse` and full-document `serialize`
delegate directly to the pure markup codec. `serializeBlockBodies` delegates to
`markup.serializeBlocks` for hashless resolver/find normalization; callers should
not reimplement trailing-newline or empty-paragraph normalization. The adapter
adds the agent-edit-only display forms `serializeBlock(block, hash)` and
`serializeBlocks(blocks, hashes)`, formatting single-line blocks as `hash|body`
and multiline blocks as `hash|\nbody`.

Markdown/MDX BlockCodec and MarkCodec registration, unified/remark assembly, and
component registry types live in `@meridian/markup`. Codec factories require the
host's ProseMirror `Schema`; agent-edit has no default Meridian schema.
`@meridian/prosemirror-schema` is a devDependency only — host composition passes
the schema explicitly. This keeps the package host-agnostic without server/infra
dependency leaks.

### AgentEditModel (`src/ports/model.ts` — port, `src/model/y-prosemirror.js` — v1 impl)
Structural model port for what "block" means to the editing core. The kernel
sees opaque `DocHandle`/`BlockRef` handles; adapters own the concrete CRDT
objects. The seam carries block lookup/identity, text inspection, Tier 1/3
mutation verbs, neutral inline runs, adapter-owned `applyInlineReplacement`, and
batch projection/serialization (`projectBlocks`, `serializeBlockLines`,
`serializeBlockBodies`). v1 is y-prosemirror only. `yProsemirrorModel(schema)` is
explicit; the server composition root supplies Meridian's fiction schema. Hosts
depend on the structural `AgentEditModel` port, not the concrete
y-prosemirror model type.

### Batch paths — preferred for multi-block operations

The per-block helpers each re-scan the **whole document block list** to produce
one block's result, so a per-block loop is **O(B²)**, not O(B):

- `getBlockId(block)` resolves a unique hash against *all sibling blocks* (re-sorts and re-hashes every sibling per call).
- Single-block codec projection rebuilds the *entire ProseMirror tree* (O(D)) to project one block.
- `AgentEditCodec.serializeBlock` does per-block serialization work.

Every batched write touches all of these (snapshot, render, find). **Use the batch path for any multi-block op:**

| Batch | Replaces (do not loop) | Does once |
|---|---|---|
| `getDocumentBlockIds(doc)` | per-block `getBlockId` for document order | sort + unique-hash all blocks |
| `model.projectBlocks(doc)` | single-block codec projection loops | project the codec block tree once |
| `model.serializeBlockLines(doc, codec, blocks?)` | per-block `serializeBlock` | allocate one unified runtime for hash-prefixed read/echo lines |
| `model.serializeBlockBodies(doc, codec, blocks)` | ad hoc `serialize([block])` + newline/sentinel cleanup | hashless block-body normalization |
| `blockHashesForDoc(doc)` / `uniqueHashesForBlocks` | per-block `getBlockHash` | the sorted unique-hash pass |
| `ReversalStore.mutationsForWrites(docId, threadId, handles)` | per-handle `mutationsForWrite` | one query |

Callers already on the batch path: `snapshotBlocks` (`apply/echo.ts`),
`renderBlockLines` / `renderOutline` (`tool/document-renderer.ts`),
`serializeScopeBlocks` (`resolver/find.ts`), `lookupBlockHash`
(`resolver/block-hash.ts`), and echo after-snapshots in
`tool/mutation-commit.ts`. Response staging no longer recomputes per-write echoes
at commit time. The Drizzle journal adapter commits a
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
`commitResponse(responseId, options?)`, `rollbackResponse(responseId)`,
`getAvailability(docId, threadId)`, `undo(docId, threadId)`,
`redo(docId, threadId)`, `reverse(input)`, and `invalidateThread(docId, threadId)`; `undoTurn` and
`redoTurn` remain host-compatible aliases. Host
runtimes that pass `WriteContext.responseId` must call exactly one of the
response lifecycle methods after the model response finishes or is cancelled.
`commitResponse` accepts `ResponseCommitOptions.destination` for hosts that need
to redirect a staged response to a non-default journal/projection boundary
without creating a second core.
`getAvailability` is the source of truth for whether write-level undo/redo will
attempt work: undo requires active mutation metadata plus the retained earliest
forward row for that turn; redo requires a retained reversed record/update, the
retained earliest forward row for the reversed turn, and the existing linear-redo
eligibility check. `invalidateThread` evicts cached runtime state and staged
response buffers for a document/thread so the next access rebuilds runtime state
from the live document and journal.

`reverse(input)` accepts `requireEffect: true` for host workflows that must distinguish "planned and persisted" from "the live Yjs document actually changed". The effect check is inside agent-edit and compares `Y.encodeStateAsUpdate` before/after reversal, not state vectors, so delete-set effects are included.

## Architecture

### Codec pipeline
```
@meridian/markup: source string → unified parser → mdast → BlockCodec dispatch → MarkCodec dispatch → PM nodes
@meridian/markup: PM nodes → BlockCodec.serialize → MarkCodec.serialize → mdast → unified stringify → source string
```
Block hash prefix added by `AgentEditCodec.serializeBlock()` at render time (not stored as
attribute). In the built-in adapter the hash is derived from the adapter-internal
Y.XmlElement CRDT item ID (`clientID + clock`); kernel callers see only the
neutral `BlockRef`.

### 3-tier apply (`src/apply/tiers.ts`)
Preflight-before-mutate discipline: Phase 1 (read-only) validates all
references, parses content, computes offsets, checks Tier 1 eligibility with
neutral inline runs plus the model-owned plain-text replacement query. Phase 2
(inside `doc.transact()`) applies pre-computed operations; Tier 2 formatted text
replacement is delegated to the adapter-owned `applyInlineReplacement` verb.

| Tier | Kind | Mechanism |
|---|---|---|
| 1 | `text` with same-mark span | Direct Y.XmlText delete + insert |
| 2 | `text` crosses mark boundary or formatting change | Adapter-owned inline replacement + per-block updateYFragment |
| 3 | `insert` / `delete` | Adapter-owned block insert/delete (Y.XmlElement fragment ops in the built-in adapter) |

Last-block edge case: deleting the only remaining block clears text instead of
structurally deleting (the built-in adapter preserves ProseMirror `doc(block+)`
internally).

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

Lineage has two distinct persisted authorities.
`document_yjs_reversals.redo_update_seq` records the current active redo closure
(state): handles that are active because of the same redo update must undo
together. `document_yjs_reversal_ops` records durable reversal op identity
(history): old undo/redo update seqs are exempt from dependency blocking even
when the current state has moved on. Both authorities compact with the retained
Yjs update log so closure and dependency checks only target retained update seqs.
The pure lineage entry point is `selectUndoClosure(...)`; callers pass the
journal snapshot, reversal rows, unfiltered candidate mutation rows, selected
handles, candidate handles, and reversal-op seqs, then receive the undo closure or
refusal verdict. The helper steps behind that API (compatible groups, boundary
expansion, seq ownership, dependency evaluation) are private implementation
details.

**Write-level undo:** each `write()` call is its own durable mutation row. Undoing without a selector reverses exactly the latest active write. Each write has a stable per-(document, thread) handle (`w1`, `w2`, …) stored on mutation metadata and never renumbered. `undo`/`redo` can target `{to:"w3"}`, an inclusive `{from:"w2", to:"w5"}` range, `{last:N}`, or `{all:true}`. Range reconstruction still uses Yjs UndoManager item identity: selected writes are tracked, non-selected/concurrent updates replay untracked, so same-area concurrent merge behavior is unchanged. User-facing undo notifications carry per-handle turn mappings (`writeHandleTurns`) because one closure can span multiple turns; `turnId` is only a representative fallback for grouping/reporting.


### CRDT-neutral seam, ProseMirror content currency

The resolver→apply kernel is neutral across the CRDT axis: Yjs documents and
blocks are carried as opaque `DocHandle`/`BlockRef` handles, and resolver/apply
code asks `AgentEditModel` for identity, lookup, mutation, projection, and
serialization. That does **not** mean the package is ProseMirror-neutral.
`codec-types.ts` still aliases `Block = PMNode`, `ParsedContent` still transits
the kernel, and resolver code still inspects PM block shape (`type.name`,
`isTextblock`, heading attrs, body serialization). Full PM-out-of-kernel work is
deferred in [TODO.md](TODO.md).

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

How the runtime doc, the live doc, and the staging buffer stay reconciled. Each
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
- **Persisted sync state is a restart baseline, reconciled before mutate.**
  `SyncStateStore` rows (`stateVector`, `syncedSnapshot`, `committedSnapshot`) let a
  post-restart write skip an explicit `read`, but `requireSynced` treats a loaded row
  as a *baseline only*: `hydrateFromPersistedRestart` restores the runtime from
  `syncedSnapshot`, merges live truth (`mergeLiveIntoRuntime`), and only on success
  persists **once**, keeping the original `committedSnapshot`. A failed reconcile
  seeds/persists nothing, so no stale state survives to be trusted on the next call.
- **`committedSnapshot` is the durable concurrent-detection baseline — never
  synthesize it on reconcile.** It is the snapshot the *next process* compares live
  state against to attribute concurrent human edits, and it advances **only** via
  `attachRuntime` on a real commit. The restart reconcile must preserve the persisted
  `committedSnapshot`; deriving a fresh one from the post-reconcile runtime corrupts
  the durable store and makes the agent blind to human edits made before the restart.
  Tests for this must assert the durable `SyncStateStore` row, not in-memory
  `session.documents` — the in-memory copy can look right while the durable one is wrong.
- **`read` is a self-healing reconstruction, not a merge.** Every `read` discards
  the runtime, rebuilds from canonical (live), and replays pending staged updates:
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
  (N writes → 1); each staged write already emitted its per-write echo before
  commit.
- **Echoes are one per-write function.** `computeEcho(before, after, touched,
  deleted)` expands a ±1 window around the agent-touched/deleted hashes and tiers
  each surviving post-write block independently: inserted or serialized-content
  changed from `v_pre` to `v_post` → full `hash|content`; identical context →
  first ~8 words plus `...`; outside the window → omitted. Concurrent overlap and
  structural changes are not separate modes.
- **Tool results use two content blocks.** Successful writes and undo/redo return
  metadata in block 1 (`status`, write id or reversal count, concurrent edits)
  and echo `hash|content` lines in block 2 when there are echo lines. Hosts should
  prefer structured `content` over the joined `text`.
- **Mangled-but-intact.** Two edits to the same span CRDT-merge at character level
  → garbled but never lost. The model is **told** via the echo, never prevented.
- **Commit re-sync is a delta+origin apply, not a rebuild.** It applies concurrent
  updates one at a time, attributing each touched block to human vs agent by
  persisted origin (the update bytes don't carry it). `read`'s rebuild can't
  attribute, so it is not used for the commit re-sync.
- **Sequential tool dispatch is load-bearing.** The host dispatches tool calls one
  at a time; writes apply to the runtime sequentially, so overlapping *self*-writes
  compose or `no_match` rather than self-mangle. Parallelizing the dispatch
  (`Promise.all`) would let two writes resolve against the same snapshot and
  self-mangle at commit.
- **The staging buffer is the durable commit source, not the runtime doc.** The
  runtime is a scratchpad (find resolution + rendering). Commit applies the buffer
  to live exactly once; `read`'s replay touches only the runtime and never
  double-commits. Internal callers that need the per-document staged entries use
  `stagedEntriesForDoc`; the public commit seam is
  `commitResponse(..., { destination })`, not direct buffer mutation.
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
the staged entries in one journal batch and, by default, applies one aggregate
Yjs update per document to the live projection. Journal batch failure leaves the
buffer retryable and invalidates staged runtimes so ordinary later reads do not
see phantom edits. If the journal batch lands, the whole response is durable and
remains the latest undoable turn even when the post-commit projection fails. In
the default live destination, `commitResponse(responseId)` recovers live docs from
the journal, rebuilds and reattaches the affected runtimes, and returns success;
only a recovery failure invalidates runtimes so next access rebuilds from journal
truth.
`rollbackResponse(responseId)` is cancellation for uncommitted buffers: it
discards staged updates and restores affected runtime docs from live. If called
after a journaled commit attempt, it is recover-only.

**Response commit destination:** `ResponseCommitDestination` lets a host redirect
the same staged response into another append boundary. `journal` overrides where
the batch is appended. `projection: false` skips the live coordinator merge.
`attachRuntime: false` evicts the staged runtime after commit instead of marking
it synced; use this when the committed entries should not become the live runtime
state. `recoverCommittedResponseProjection` and `committedSnapshot` let the host
define destination-specific recovery and concurrent-detection baselines. Once a
journal append succeeds, retry identity is bound to the destination; retrying the
same response with a different destination throws rather than risking a duplicate
commit against a different journal/projection pair.

**Deferred commit must complete the merge+sync lifecycle.** Staging is an
optimization: instead of merge+re-sync per write, a response's writes batch into
**one** lifecycle run at `commitResponse` (N writes → 1 merge+sync). Only the
merge+re-sync is collapsed. Commit no longer recomputes per-write echoes; the
model already received each write's echo when the write was staged.
`documents[*].concurrentEdits` is the document-level human/agent touched-hash
summary from the one re-sync and keeps the collapse-threshold behavior. The
garbled character-level merge of two edits to the same text is accepted
("mangled-but-intact") — the model is told through the write echo and concurrent
summary, not prevented. Mid-response, per-write echoes reflect the local runtime
(there is no per-write re-sync to live) — the accepted cost of the optimization,
not a defect. An explicit `read` still reconstructs from canonical (see the
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
model-facing text must render the display `file` / `filePath`, including read
commands, creation guidance, not-found messages, and re-sync hints. The package
stays host-agnostic: it does not invent display paths, it only echoes the path
the host supplied. Tests should prefer UUID-like document ids plus friendly
paths so accidental UUID interpolation fails loudly.

## v1 simplifications (deferred, documented for discoverability)

- **Tool versioning** deferred (GH issue #68). Seam kept clean — pure
  resolvers, stable `ResolvedEdit`, version-agnostic apply layer. No version
  pinning until a v2 exists.
- **Read auto-budget/truncation** deferred. Current `read` returns full
  content. Thread-level context management is not yet implemented.
- **Generic concurrent attribution** deferred to server adapter. `concurrent
  edits` reports `human` vs `agent` categories; no individual actor names.

- **Cross-block `find`** (find string containing `\n\n`) supported via
  structural lowering in the resolver. Routes to Tier 2+3.

## Testing

Package tests cover block-hash stability, markup round-trip, resolver with
cross-block find, 3-tier apply preflight + edge cases, echo computation, cold
undo/redo reconstruction (including the 8-case reconcile matrix, subset redo,
drift invariants, availability, and public turn seams), response
staging/recovery, and create lifecycle.

### Write handles and selective reversal

Every successful mutating write returns a short handle line (`write id: w<N>`) in the metadata block. The ordinal is allocated per `(document, thread)`, persisted on the mutation row, and never reused or renumbered by undo/redo. `WriteContext.tool_use_id` remains the durable idempotency id in mutation metadata; `w<N>` is the model-facing range key.

Undo/redo echoes use the same two-block result format as writes: metadata first, echo lines second.

Undo/redo defaults to the latest write. The command surface also accepts one write (`to`), inclusive ranges (`from` + `to`), newest N (`last`), or all (`all`). The cold reconstruction algorithm is unchanged except that its selected target is a set of write seqs rather than one turn id; non-selected and concurrent updates still replay untracked through Yjs UndoManager, preserving same-area merge behavior.
