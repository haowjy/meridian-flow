# Port contracts

## Port interfaces

### UpdateJournal (`src/ports/update-journal.ts`)

The journal owns ordinary append, batch append, read, checkpoint and compaction,
plus durable per-document/thread write-ordinal reservation. Storage adapters expand
one logical edit's ordered parts into journal rows. `read` returns a checkpoint
and matching ordered updates; a bounded `since` read does not hide its retained
rows behind a newer checkpoint. `persistenceWatermark` includes the checkpoint's
cut even when no update rows remain above it.

Undo/redo state does not live in transport rows. `DocumentEdits` reads immutable
edit parts and delegates model stack operations to the host's inverse policy.
Compaction folds journal updates without expiring immutable receipts or lineage.

### DocumentCoordinator (`src/ports/document-coordinator.ts`)
Access to the coordinator-owned canonical Y.Doc, which may be a host branch
rather than live. `withDocument(docId, fn)` serializes callers through
this port for the same docId. It does not by itself exclude mutations arriving
through another transport; the host owns that concurrency fence.
`recover(docId)` replays persisted-but-unapplied updates on startup. Rejects
`DocumentNotFoundError` when the doc is missing.

Movable-generation hosts implement `withStagedWrites`: checked whole-write replay
and publication under their existing authority lock. It accepts an explicit helper
base cut (generation and state), independent of historical write generations,
and returns typed kept entries, new helper bytes/cut and the before cut only
after admission and CAS accept. The buffer applies kept writes, failed-receipt
owners and helper replacement together after that acceptance. The response helper is replaced from that cut plus
surviving staged writes before the next command. A discarded write and its later
dependents receive failed per-write receipts; independent writes still commit.
The prepared response view owns a private Y.Doc, replay capability and required cut.
It is never a RuntimeDocumentState and is never registered in the runtime store.
Every content exposure goes through prepare: scoped reads borrow disposable
replicas; commands stage through committer-owned call leases. Effective reads
prepare before taking a branch-read lock. No raw helper or staged-byte reader is
public. Ordinary live replicas are dispatched at the same gate. Each response lease
captures response/document/epoch; Whole Discard revokes the document epoch, including
leases issued before its first staged write. Replay acceptance and stage publication
validate it. Equivalent replay results retain view identity, so concurrent unchanged
reads do not cause triangular retries; real content/cut changes still retry.
Concurrent staging and terminal reports use separate disposable snapshots;
historical pre-own snapshots remain receipt evidence, not the current base cut.
Staging requires the document label and edit description used by failed notices.
Rollback marks the response pending settlement without changing its view. Commit
closes/disposes it (and evicts live replicas); abort restores buffered ownership
unchanged. The helper cut survives a receipt-only buffer. Notices wait in a
committer outbox that only tool results drain, including cached results without
caching their notice. Notices group by document and handle, distinguish partial from whole rejection and name the rejected writes.
Terminal concurrency reporting uses the frozen pre-publication cut, so the
response's own newly journaled rows are not mistaken for concurrent writer text.
The ordinary live-document path and durable recovery remain unchanged.

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
host's ProseMirror `Schema`. `createAgentEditCodecFactory(markup)` parses
purely; every command takes its codec once at entry (`tool/command-links.ts`
`openCommandLinks`: `links.prepare` then `links.scopeFor`, then
`codec.forScope(scope)`) and passes that scoped `AgentEditCodec` everywhere it
serializes. agent-edit has
no default Meridian schema and no project tree of its own.

### DocumentLinksPort (`src/ports/document-links.ts`)
The host's link scope: `prepare` (one batched load per synchronous block),
`scopeFor(documentId, context)` (holder and view from the arguments),
`registerAhead` (durable, outside any transaction) and `revision`. A host that
routes between versions names the view on every command it routes
(`WriteContext.linkView`). A reply's save prepares each document's before sides (`preOwnSnapshot`) with its
disposable current-view replica, since receipts spell links the reply removed.
Save-time replicas are disposed in finally, including failed link preparation.
Markup's `createHolderLinkScope(holder, catalog)` applies the contracts'
resolution and spelling rules over any `HolderCatalog` (the client resolves
through the same rules over its own catalog), so hosts cannot disagree;
`createStaticDocumentLinks(catalog)` is the in-memory adapter over a fixed
catalog. It loads keys on `prepare` the way the server's batched loader does
and answers an unprepared id, settlement or address as a snapshot miss
(recorded in `misses`), so tests catch a door that forgot to prepare; the
server's in-memory composition passes `{ preloaded: true }`.
Markup's `storedLinkKeys` (beside the Yjs walk `extractStoredLinks`) is what
both adapters
load for stored occurrences (docs and `stored` nodes such as copies) and for
shown identities (an `asset:<id>` one loads its upload by id).
After parse, `links/assign-refs.ts` applies the shipped image rule (a known
manuscript path becomes `asset:<id>`) in pass 3 of ref assignment, to written
sources nothing old or shown continued; copies are never assigned.
`@meridian/prosemirror-schema` is a devDependency only — host composition passes
the schema explicitly. This keeps the package host-agnostic without server/infra
dependency leaks.

### AgentEditModel (`src/ports/model.ts` — port, `src/model/y-prosemirror.js` — v1 impl)
Structural model port for what "block" means to the editing core. The kernel
sees opaque `DocHandle`/`BlockRef` handles; adapters own the concrete CRDT
objects. The seam carries block lookup/identity, visible-content CRDT lineage,
text inspection, plain-text (undo repair) and structural
mutation verbs, a nonempty inline-run count for undo repair, adapter-owned `applyInlineReplacements` and
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

Multi-block reads and writes touch these paths. **Use the batch path for any multi-block op:**

| Batch | Replaces (do not loop) | Does once |
|---|---|---|
| `getDocumentBlockIds(doc)` | per-block `getBlockId` for document order | sort + unique-hash all blocks |
| `model.projectBlocks(doc)` | single-block codec projection loops | project the codec block tree once |
| `model.serializeBlockLines(doc, codec, blocks?)` | per-block `serializeBlock` | allocate one unified runtime for hash-prefixed read/echo lines |
| `model.serializeBlockBodies(doc, codec, blocks)` | ad hoc `serialize([block])` + newline/sentinel cleanup | hashless block-body normalization |
| `blockHashesForDoc(doc)` / `uniqueHashesForBlocks` | per-block `getBlockHash` | the sorted unique-hash pass |

Callers already on the batch path: `snapshotBlocks` (`apply/echo.ts`),
`renderBlockLines` / `renderRead` (`tool/document-renderer.ts`),
`serializeScopeBlocks` (`resolver/find.ts`), `lookupBlockHash`
(`model/block-hash.ts`), and echo after-snapshots in
`tool/mutation-commit.ts`. Response settlement recomputes each staged write's
receipt against the settled runtime projection before the host publishes it.
Receipts carry a unique host-only settlement id because several tool calls may
intentionally share one model-facing write handle.
The Drizzle journal adapter commits a buffered response in one multi-row INSERT
via `appendBatch` (per-update
`appendMutation` was deleted). The in-memory test journal implements the same
batch API.

### ActorSessionStore (`src/ports/actor-session-store.ts`)
Stable identity for external callers. Maps transport-level IDs to persistent
sessions that survive reconnects. The core library operates on `ActorSession`
only. Each session tracks initialized document membership as a set, not retained
state vectors; live sync and stale-document recovery remain runtime-store duties.
Optional — falls back to a local in-memory map when omitted.

### AgentEditCore (`src/index.ts`)

The default facade exposes `read`, `write`, `recover`, response commit/rollback,
prepared read leases, response-document discovery and thread invalidation.
`WriteContext.responseIdentity` separates provider authorship from helper scope;
the host settles that scope exactly once. `invalidateThread` drops buffered
writes and evicts the runtime so the next access starts from its canonical view.

Model `undo`, `redo`, `revert` and `read(format: "edits")` use `DocumentEdits` after
the prepared-lease gate. The host owns destination choice, stack policy, immutable
receipt persistence, notices and publish-after-commit. No public core method
reconstructs an UndoManager from historical journal rows.

Normal live projection still classifies visible content before and after the
synchronous Yjs apply. Journal submission precedes projection; response recovery
follows explicit acceptance, never a failed receipt renderer. The echo is best
effort reporting, not mutation authority.
