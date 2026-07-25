# Port contracts

## Port interfaces

### TurnDiffQuery (`src/ports/turn-diff-query.ts`)

Read-only host seam for the current turn's folded, shell-state-aware change
trail. Agent-edit renders prose windows and never reads collab tables or CRDT
identities; shared-shell effects are flagged without attributing them to the
turn.

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
`ReversalStore.reserveWriteOrdinal`; a host may supply a durable group ID and
reuse one ordinal for that group when its journal folds the mutations into one
row. Each staged mutation also marks replacement-scope capture complete and
carries certified semantic scope for replacements, including create-overwrite,
so folding hosts can retain per-write scope without serializing live block
handles. Undo/redo selection and availability then use the same store to plan
against retained update rows and mutation metadata.
Hosts with movable reversal authority implement `withReversalScope` so one
command plans and persists against one pinned authority. A reconstruction that
adds synthetic reconciliation updates exposes its durable
`persistenceWatermark` separately from those synthetic sequence numbers.
Scope reversal is operation-atomic: every selected group is reconstructed
before persistence. Multi-group redo is consumed by
`persistRedoBatch` in one store transaction, then the prepared updates are
projected together.

Persistence results distinguish durable from staged commits. A failed staged
projection restores or evicts the runtime before reporting failure. A failed
projection after a durable reversal recovers from the journal and reports the
committed outcome; diagnostics must not turn that committed effect into an
`internal_error`.

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
Optional host callback for reversal delivery. Agent-edit passes
`threadId`, `docId`, a representative `turnId`, write handles, direction, and
`writeHandleTurns` (the per-handle turn mapping) after a successful user-actor
undo/redo persist; hosts resolve `docId` to any product URI outside the package.
When a writer WebSocket edit lands after commit preflight but before a durable
reversal applies, `recordLateSweep` reports the affected hashes, captured bodies,
and before-content reference for both user and agent actors. Hosts without the
port still apply the durable reversal but cannot deliver that receipt.

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
objects. The seam carries block lookup/identity, visible-content CRDT lineage,
text inspection, Tier 1/3
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
`tool/mutation-commit.ts`. Response settlement recomputes each staged write's
receipt against the settled runtime projection before the host publishes it.
Receipts carry a unique host-only settlement id because several tool calls may
intentionally share one model-facing reversal handle.
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
`withResponseDocument(...)`, `responseDocuments(...)`,
`getAvailability(docId, threadId)`, `undo(docId, threadId)`,
`redo(docId, threadId)`, `reverse(input)`, and `invalidateThread(docId, threadId)`.
Raw staged Yjs bytes stay private; `withResponseDocument` lends the effective
response view for the duration of one callback. Composition ports, concrete
adapters, snapshots, provenance algebra, and Yjs utilities live on the explicit
`@meridian/agent-edit/integration` entry instead of the default façade. Host
runtimes that pass `WriteContext.responseId` must call exactly one of the
response lifecycle methods after the model response finishes or is cancelled.
`getAvailability` is the source of truth for whether write-level undo/redo will
attempt work: undo requires active mutation metadata plus the retained earliest
forward row for that turn; redo requires a retained reversed record/update, the
retained earliest forward row for the reversed turn, and the existing linear-redo
eligibility check. `invalidateThread` evicts cached runtime state and drops buffered
response updates for a document/thread so the next access rebuilds runtime state
from the live document and journal.

Cold/restart/hosted reversals derive their live-journal watermark from durable
reconstruction when the host does not supply an `InteractionContext`.
`InteractionContext.liveJournalSeq` remains the reconstruction reference;
`afterJournalId` remains a host attribution floor and must not be used as one.
`InteractionContext.attributionBaseline` is the thread peer's CRDT state
captured before the host pulls concurrent upstream changes. It feeds provenance
classification, not the document echo: a success echo renders only the
post-write projection, while pulled or settlement-time changes use the typed
concurrent-edit report.

Reversal application captures commit preflight before persistence, then the
mutation committer's final recheck resumes from that immutable detection after
persistence. This catches both edits inside the durable-write window and edits
inside the final concurrent-detection window; the shared classifier alone
decides whether the committed update produces a late-sweep report
(durable-then-report).

Every normal live projection classifies the coordinated document immediately
before and after the synchronous Yjs apply. The final recheck and apply have no
await between them. The shared lifecycle-neutral classifier consumes those
visible occurrences and durable writer/agent provenance, returning eligible
ranges plus final-rendering projections. Agent writes always commit through Yjs
merge; classification controls only writer-facing sweep capture and trails. The
echo informs the agent, the trail informs the writer, and agent-only destruction
stays silent.

Immediate writes, local-runtime synchronization, and response phase-C projection
compose the same lock-scoped apply kernel. When journal entries are supplied,
the kernel appends them before its final concurrent recheck; already-durable
response commits enter through the same kernel without re-appending.

`reverse(input)` accepts `requireEffect: true` for host workflows that must distinguish "planned and persisted" from "the live Yjs document actually changed". The effect check is inside agent-edit and compares `Y.encodeStateAsUpdate` before/after reversal, not state vectors, so delete-set effects are included.
