# agent-edit — contracts, architecture, invariants

## Port interfaces

### UpdateJournal (`src/ports/update-journal.ts`)
The only hard port. Append, read (checkpoint + updates), checkpoint, compact,
`appendBatch` (all-or-nothing response commit across documents),
`persistReversal` (atomically persist undo update + reversal record),
`persistRedo` (atomically consume a doc+thread+turn reversal and append redo
bytes), `readReversals` (durable redo lookup), and the mutation metadata queries
used by availability (`latestActiveTurn`, `activeTurnSummary`,
`turnMinCreatedSeq`). Ordered by monotonic seq per document. Every adapter
implements this. Response staging buffers the same
`{ docId, update, agentMeta(turnId) }` entries and commits them with one
`appendBatch(...)` call from `commitResponse(responseId)`; mutation entries mint
their rows in the same transaction.

The mutation reads deliberately live on `UpdateJournal`, not a separate
`MutationStore` port. Hosts implement one adapter for the journal table and the
mutation metadata table that changes with it, so the co-sourcing guarantee is
structural. Internal consumers still depend on narrow read slices such as
`MutationQueries`, which picks only `latestActiveTurn`, `activeTurnSummary`, and
`turnMinCreatedSeq` from `UpdateJournal`.

Checkpoint callers pass `upToSeq`, the highest update sequence the encoded
state is allowed to hide from replay. It must not be higher than what the state
contains; replaying an already-included update is idempotent, but skipping one
is durable data loss.

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
owns the PM-mapping dispatch. `serialize`/`parse` are the two directions.
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

### ActorSessionStore (`src/ports/actor-session-store.ts`)
Stable identity for external callers. Maps transport-level IDs to persistent
sessions that survive reconnects. The core library operates on `ActorSession`
only. Optional — falls back to a local in-memory map when omitted.

### AgentEditCore (`src/index.ts`)
The public package façade exposes `write()`, `recover()`, `compact()`,
`commitResponse(responseId)`, `rollbackResponse(responseId)`,
`getAvailability(docId, threadId)`, `undoTurn(docId, threadId)`,
`redoTurn(docId, threadId)`, and `invalidateThread(docId, threadId)`. Host
runtimes that pass `WriteContext.responseId` must call exactly one of the
response lifecycle methods after the model response finishes or is cancelled.
`getAvailability` is the source of truth for whether turn-level undo/redo will
attempt work: undo requires active mutation metadata plus the retained earliest
forward row for that turn; redo requires a retained reversed record/update, the
retained earliest forward row for the reversed turn, and the existing linear-redo
eligibility check. `invalidateThread` evicts cached runtime state, staged
response buffers, and the hot `UndoManager` for a document/thread so the next
access rebuilds from the live document and journal.

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

**Hot path** — live `Y.UndoManager` per `(docId, threadId)` pair in
`UndoManagerRegistry`. Each thread gets a stable origin `Symbol` (same object
across all turns — Yjs origin tracking uses object identity).
`stopCapturing()` at turn boundaries groups writes into separate stack items.
`captureTimeout: Infinity` — no auto-merge; explicit split only.

**Cold path** — reconstruction from `UpdateJournal` when UndoManager is gone.
Replay checkpoint + updates, assign per-turn `Symbol` tokens, create fresh
UndoManager, replay target turn with tracked token, undo/redo, extract bytes.
Authoritative model; hot path is a performance cache. Redo survives process
restart by rehydrating `runtime.redoStack` from `ReversalRecord` rows with
`status: "reversed"` during the first `view` sync for that `(session, doc,
thread)`. Rehydration filters expired records and records made stale by later
forward agent/human updates. Redo consumption is authoritative at persist time:
`persistRedo()` rechecks the doc+thread+turn reversal is still `status:
"reversed"` inside the append transaction, marks it `status: "redone"`, and
returns `consumed: false` without appending when another session already used it.

**Hot/cold parity:** both paths must produce byte-identical undo results for
the same turn sequence. Enforced by tests (`undo.test.ts`).

**Turn-level undo:** each `write()` call is its own Yjs transaction. The
`UndoManagerRegistry` creates a fresh undo stack item per turn boundary
(not per command). Undoing a turn reverses ALL writes from that turn together.

## Key invariants

- **Block hash stable under edits.** Derived from CRDT item ID (assigned at
  element creation). Survives content edits, position shifts, reordering.
  Lost on type change or deletion (new element → new ID).
- **Codec round-trip stability.** Arbitrary markdown/MDX normalizes on first
  parse. Repeated serialize → parse cycles produce identical output.
- **Hot/cold parity.** Live `um.undo()` and reconstructed `undo()` produce
  identical document state for the same turn.
- **Public mutations stay at turn/tool seams.** Low-level mutators
  (`applyTextEdit`, `insertBlocks`, etc.) are not exported from the package
  root; callers mutate through `write()` or the turn-level undo/redo seams.
- **Coordinator/runtime failures → `internal_error`**, not
  `document_not_found`. Only document-missing from the coordinator is
  `document_not_found`.
- **Turn boundaries split via explicit `stopCapturing()`**, not
  `captureTimeout`. Without explicit splitting, all turns merge into one
  stack item.

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
reattaches the affected runtimes without restoring baseline undo/redo stacks,
and returns success; only a recovery failure invalidates runtimes so next access
rebuilds from journal truth. `rollbackResponse(responseId)` is cancellation for
uncommitted buffers: it discards staged updates, restores affected runtime docs
from live, and evicts hot undo managers for those threads. If called after a
journaled commit attempt, it is recover-only and never restores baseline
undo/redo stacks.

Without `responseId`, writes keep the immediate append + live sync behavior.
`undo` / `redo` are not staged; if a response buffer exists when undo/redo runs,
the buffer is committed first so reversal order matches tool-call order.
`commitResponse()` and `rollbackResponse()` also report staged-create outcomes
for hosts that created path-level placeholders before the journal commit:
committed creates must keep their path, while only pre-commit discards should be
deleted. `invalidateThread()` marks pending staged creates as discarded inside
the response buffer so a later empty commit still carries the cleanup signal.

**`path` vs `file`:** The model-visible schema uses `path` (a context URI).
The server adapter resolves `path` → `documentId` → `file` for the package
(`apps/server/server/lib/wired-core-tools.ts:239-275`). The package never sees
Meridian URI schemes — it operates on plain `{ file: "<docId>#fragment" }`.

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
cross-block find, 3-tier apply preflight + edge cases, echo computation,
hot+cold undo (8-case reconcile matrix + Q2b interleaved multi-agent +
hot/cold parity), response staging/recovery, create lifecycle, and
compact-on-load.
