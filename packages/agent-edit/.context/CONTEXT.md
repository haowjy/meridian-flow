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

`ResponseCommitter` commits buffered response updates through `UpdateJournal.appendBatch`.
Forward write mutation entries reserve a per-thread `w<N>` ordinal through
`ReversalStore.reserveWriteOrdinal`; undo/redo selection and availability then
use the same store to plan against retained update rows and mutation metadata.
Scope reversal is operation-atomic: every selected group is reconstructed and
safety-preflighted before persistence. Multi-group redo is consumed by
`persistRedoBatch` in one store transaction, then the prepared updates are
projected together. A policy rejection therefore leaves every selected group,
the journal, and the live document untouched.

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
mutation verbs, neutral inline runs, adapter-owned `applyInlineReplacement` and
same-type `applyBlockReplacement`, and batch projection/serialization
(`projectBlocks`, `serializeBlockLines`, `serializeBlockBodies`). v1 is
y-prosemirror only. `yProsemirrorModel(schema)` is explicit; the server
composition root supplies Meridian's fiction schema. Hosts depend on the
structural `AgentEditModel` port, not the concrete y-prosemirror model type.

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
`tool/mutation-commit.ts`. Response commits do not recompute per-write echoes.
The Drizzle journal adapter commits a buffered response in one multi-row INSERT
via `appendBatch` (per-update
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
`redo(docId, threadId)`, `reverse(input)`, and `invalidateThread(docId, threadId)`; `undoTurn` and
`redoTurn` remain host-compatible aliases. Host
runtimes that pass `WriteContext.responseId` must call exactly one of the
response lifecycle methods after the model response finishes or is cancelled.
`getAvailability` is the source of truth for whether write-level undo/redo will
attempt work: undo requires active mutation metadata plus the retained earliest
forward row for that turn; redo requires a retained reversed record/update, the
retained earliest forward row for the reversed turn, and the existing linear-redo
eligibility check. `invalidateThread` evicts cached runtime state and drops buffered
response updates for a document/thread so the next access rebuilds runtime state
from the live document and journal.

Agent reversals require a trustworthy pre-sync baseline: either an explicit
`InteractionContext.baselineSnapshot` or a session runtime acknowledged by a
prior read/write. Cold/restart/hosted agent calls without one fail closed with
`rejected_response_requires_reread`; they never sync live state and then call it
the baseline. User reversals remain ungated and capture a best-effort pre-sync
baseline. `InteractionContext.liveJournalSeq` is the live-journal watermark
paired with that baseline; `afterJournalId` remains a host attribution floor and
must not be used as a reconstruction reference.

`reverse(input)` accepts `requireEffect: true` for host workflows that must distinguish "planned and persisted" from "the live Yjs document actually changed". The effect check is inside agent-edit and compares `Y.encodeStateAsUpdate` before/after reversal, not state vectors, so delete-set effects are included.

## Architecture

### `src/tool/` module map

`write.ts` is the composition façade; behavior belongs in the module that owns
its concern. Production modules (excluding colocated tests) are:

| Module | Responsibility |
|---|---|
| `command-schema.ts` | Canonical validation schema for model-facing write commands. |
| `coordinator.ts` | Translates live-document coordinator failures into tool results. |
| `document-renderer.ts` | Parses agent input and renders document blocks for reads and echoes. |
| `interaction-mode.ts` | Carries live vs thread-peer interaction context, baselines, and branch-generation fences. |
| `internal-result.ts` | Internal result envelopes below the public `WriteOutcome`. |
| `mutation-commit.ts` | Appends journal batches, projects committed updates to live docs, and computes concurrent-edit summaries. |
| `response-lifecycle.ts` | Defines response transition values used by the committer and observability. |
| `response-committer.ts` | Buffers response writes and owns their journal, live-projection, recovery, rollback, and closed-tombstone state machine. |
| `response-format.ts` | Formats shared write/reversal statuses and public outcomes. |
| `runtime-store.ts` | Owns per-session runtime Y.Doc attachment, reconstruction, eviction, live sync, and stale-live flags. |
| `types.ts` | Public command, context, outcome, lifecycle event, and response result types. |
| `write-commands.ts` | Implements read/create/insert/replace handlers. |
| `write-deps.ts` | Defines public write-tool construction options. |
| `write-dispatch.ts` | Dispatches validated commands to supplied command/reversal handlers. |
| `write-helpers.ts` | Shared parsing, identity, and error helpers. |
| `write-idempotency.ts` | Scopes and bounds the `tool_use_id` replay cache and emits hit telemetry. |
| `write-reversal-endpoints.ts` | Adapts hosted and tool undo/redo/reverse calls and thread invalidation to the reversal engine. |
| `write-reversal.ts` | Executes write-level undo/redo from durable journal reconstruction. |
| `write.ts` | Wires the modules into the public `WriteTool`; it contains no command implementation. |
| `test-support/` | Shared package-test journals, harnesses, scenarios, and assertions. |

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
| 2 | `text` crosses mark boundary/formatting change, or a same-type complex block changes | Adapter-owned inline or whole-block replacement + per-block updateYFragment |
| 3 | `insert` / `delete` | Adapter-owned block insert/delete (Y.XmlElement fragment ops in the built-in adapter) |

Last-block edge case: deleting the only remaining block clears text instead of
structurally deleting (the built-in adapter preserves ProseMirror `doc(block+)`
internally). Structural replacement inserts its new blocks before deleting old
parents, so a non-empty requested document never leaves a cleared trailing block.

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
- **Tool results use two content blocks.** Successful writes and undo/redo return
  metadata in block 1 (`status`, write id or reversal count, concurrent edits)
  and echo `hash|content` lines in block 2 when there are echo lines. Hosts should
  prefer structured `content` over the joined `text`.
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
- **`find` reconciliation happens in serialized markdown space.** Matches resolve to
  serialized block ranges. The resolver splices the requested replacement into the
  markdown source, parses that affected range, and lowers through `replaceScope(...)`
  so single-block and cross-block finds share the same parse+diff path. A narrow
  Tier-1 fast path is allowed only when the matched block body is already identical
  to flat editable text and the replacement is plain text; formatted/escaped/entity
  cases must not use serialized-body→flat offset mapping.

## Tool surface

`write()` returns a structured `WriteOutcome { command, status, isError, text }`
(`src/tool/types.ts`). The host routing layer reads the structured envelope; the
LLM-facing response is the plain `text` field (status line + echo + content).
`idempotency` is provided by `tool_use_id`, but provider tool ids are
response-local: cache and durable attempt ids scope them by `responseId`, or by
`turnId` when no response id exists. Same-response retries return the cached
text; a later response that reuses the same provider id must dispatch as a new
write.

### Response commit lifecycle

Passing `WriteContext.responseId` makes `create` / `insert` / `replace` apply to
the session runtime immediately while `ResponseCommitter` buffers the exact
updates and mutation metadata that will be committed. Per-write echoes therefore
reflect cumulative response-local state. Without a response id, the same command
path appends and projects immediately. Undo/redo never buffer: a tool reversal
first commits any buffered writes for that response so durable order matches tool
order.

Lifecycle ownership is exclusive: `Buffered | Committing | Closed`.

- **`Buffered`:** owns the mutable response buffer. Only this state may stage or
  drop writes. `commitResponse` atomically snapshots the buffer and transfers
  ownership to `Committing` before any asynchronous work begins.
- **`Committing`:** owns one immutable snapshot and one promise across journal
  append, live projection, and recovery. Concurrent commit callers join that
  promise even after append has completed. Its observable operational phase moves
  from `buffered` to `journalCommitted` to `liveProjected` without replacing the
  owner. Rollback is rejected while this owner exists; reporting rollback success
  while a commit can still persist would make the caller's cancellation contract
  dishonest.
- **`Closed`:** records a bounded `committed` or `rolledBack` tombstone. Further
  stage/commit/rollback calls fail; an unknown response id remains a valid empty
  commit/rollback because a model response may have issued no mutations.

Journal append throws directly. Live projection returns a narrow outcome carrying
its accepted journal kind, which lets the write boundary restore speculative
runtime state before acceptance or route durable projection failure through
journal recovery. State transitions verify the current owner before changing the
map, preventing stale async work from reopening or overwriting a closed response.

**Rollback and recovery follow the journal boundary.** While still `buffered`,
commit failure evicts speculative runtimes but leaves the response retryable;
rollback restores existing runtimes from live (and evicts runtime-only creates),
then closes `rolledBack`. After any accepted journal batch, rollback is
recover-and-close rather than buffer discard. For `"durable"`, those rows cannot
be undone by lifecycle rollback: projection failure triggers journal recovery and
runtime reconstruction. Successful recovery is reported as a successful commit;
failed recovery evicts runtimes, marks live state stale, closes the durable
response as committed, and still reports the projection failure to the caller.

`dropForThread` may mutate only a `buffered` response. Commit owns immutable
snapshots after that phase, so invalidation or hosted reversal cannot remove rows
mid-append or mid-projection. Dropped claims are either closed as `rolledBack`
when nothing remains or retained as `discardedClaims` alongside surviving commit
results; pending create cleanup remains visible through `stagedCreates`.

`commitResponse()` and `rollbackResponse()` report create outcomes for hosts
that created path placeholders before journal commit: committed creates keep
their path, while only pre-commit discards are cleanup candidates.

### Mutation outcomes

`response-lifecycle.ts` contains only the response transition values used by the
committer and observability. Immediate mutation submission returns the journal
kind needed by the atomic apply→submit boundary; unused write constructors,
aggregate wrappers, and generic transition `Result` ceremony were deleted. The
public `WriteOutcome.phase` remains `"staged" | "committed"`; hosts must not treat
a staged success as durable. `discardedClaims` is returned directly by the owning
committer and preserved by the server response owner.

Every journal batch still reports `"durable"` or `"syntheticPending"`.
`MutationLifecycle` preserves that distinction through journal and live phases;
`journalCommitted` means the adapter accepted the batch, not necessarily that DB
rows are durable. A `syntheticPending` response may continue through
`liveProjected` and close `committed`; its journal kind still identifies it as
branch-pending rather than durable.

### Tool concerns

`tool/interaction-mode.ts` is the sole owner of `mutationMode` and
`interactionContextForAttempt`. The mode (`"threadPeer"` plus
`branchGeneration`, or `"live"`) is required end-to-end.

Within a session, idempotency keys are scoped by response id, then turn id; with
neither, the session is the fallback scope.
`onIdempotencyHit` reports `{ toolUseId, scopeKind, scopeId, sessionId, outcome }`.
Response lifecycle observers receive explicit committer transitions; discarded
mutation claims surface through `onResponseClaimDiscarded` and
`ResponseCommitResult.discardedClaims`. Observer exceptions never change
mutation control flow.

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
commit/recovery, and create lifecycle.

### Write handles and selective reversal

Every successful mutating write returns a short handle line (`write id: w<N>`) in the metadata block. The ordinal is allocated per `(document, thread)`, persisted on the mutation row, and never reused or renumbered by undo/redo. `WriteContext.tool_use_id` remains the durable idempotency id in mutation metadata; `w<N>` is the model-facing range key.

Undo/redo echoes use the same two-block result format as writes: metadata first, echo lines second.

Undo/redo defaults to the latest write. The command surface also accepts one write (`to`), inclusive ranges (`from` + `to`), newest N (`last`), or all (`all`). The cold reconstruction algorithm is unchanged except that its selected target is a set of write seqs rather than one turn id; non-selected and concurrent updates still replay untracked through Yjs UndoManager, preserving same-area merge behavior.
