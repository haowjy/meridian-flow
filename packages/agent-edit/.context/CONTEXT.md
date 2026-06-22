# agent-edit — contracts, architecture, invariants

## Port interfaces

### UpdateJournal (`src/ports/update-journal.ts`)
The only hard port. Append, read (checkpoint + updates), checkpoint, compact,
`persistReversal` (atomically persist undo update + reversal record). Ordered
by monotonic seq per document. Every adapter implements this.

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
`presets/markdown.ts`, `presets/mdx.ts`.

### DocumentModel (`src/model/types.ts` — interface, `src/model/y-prosemirror.js` — v1 impl)
What "block" means in Yjs. Carries the 3-tier apply implementation: `getBlocks`,
`getBlockId` (hash from CRDT item ID), `getText`, `applyTextEdit` (Tier 1/2),
`insertBlocks` (Tier 3), `deleteBlock` (Tier 3). v1 is y-prosemirror only.

### ActorSessionStore (`src/ports/actor-session-store.ts`)
Stable identity for external callers. Maps transport-level IDs to persistent
sessions that survive reconnects. The core library operates on `ActorSession`
only. Optional — falls back to a local in-memory map when omitted.

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
UndoManager, replay target turn with tracked token, undo, extract bytes.
Authoritative model; hot path is a performance cache.

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
- **Write() is the only public mutation entry.** Low-level mutators
  (`applyTextEdit`, `insertBlocks`, etc.) are not exported from the package
  root — only through the tool surface.
- **Coordinator/runtime failures → `internal_error`**, not
  `document_not_found`. Only document-missing from the coordinator is
  `document_not_found`.
- **Turn boundaries split via explicit `stopCapturing()`**, not
  `captureTimeout`. Without explicit splitting, all turns merge into one
  stack item.

## v1 simplifications (deferred, documented for discoverability)

- **Tool versioning** deferred (GH issue #68). Seam kept clean — pure
  resolvers, stable `ResolvedEdit`, version-agnostic apply layer. No version
  pinning until a v2 exists.
- **Durable cold-redo `ReversalRecord` lookup** deferred to server adapter
  (Step 9). Package computes the undo update; the adapter stores and
  retrieves records.
- **View auto-budget/truncation** deferred. Current `view` returns full
  content. Thread-level context management is not yet implemented.
- **Generic concurrent attribution** deferred to server adapter. `concurrent
  edits` reports `human` vs `agent` categories; no individual actor names.
- **Multi-document turn reversal** not yet implemented. Each document's
  undo runs independently; no turn-level coordination across documents.
- **Cross-block `find`** (find string containing `\n\n`) supported via
  structural lowering in the resolver. Routes to Tier 2+3.

## Testing

95 tests across the package (all pass). Key coverage areas: block-hash
stability, codec round-trip, resolver with cross-block find, 3-tier apply
preflight + edge cases, echo computation, hot+cold undo (8-case reconcile
matrix + Q2b interleaved multi-agent + hot/cold parity), create lifecycle,
compact-on-load.
