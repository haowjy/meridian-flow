# Collab — document authority, schema, and connection admission

## Current shape

| Concept | Canonical name | Code surface |
|---|---|---|
| Durable `document_yjs_heads` row and its fenced journal prefix | **document authority head** | `DocumentAuthorityHead`, `DocumentAuthorityId`, `document_yjs_heads` |
| Operation-specific capabilities that validate and admit content-bearing mutations | **document mutation policy** | `admitFreshAuthorship`, `admitCertifiedMutation`, `replicateFrozenIdentity`, `replaceAuthorityGeneration` |
| Mutable `Y.Doc` held by a loaded Hocuspocus room | **live document** | `liveDocument` / `liveDoc` in room and Hocuspocus surfaces |

“Document authority” is reserved for the durable head and its identity/generation.
Do not use it for the mutation policy or an in-memory `Y.Doc`. The policy uses
the neutral `MutationTarget` for branch, scratch, and live inputs; only room-owned
state is a live document.

## Write codec and schema coherence

`domain/markdown-document.ts` is the single content write/read and Y.Doc
projection engine. It resolves each document's filetype (composition-root
resolver injected in `composition.ts`) before every parse or serialization:
`document` → markdown codec; `code` → one `code_block` holding the raw text
verbatim (`language` = filetype), read back without fences. Checkpoint restore,
branch/effective reads, and review previews use this document-aware surface;
schema-blind serialization is private to the engine.
Checkpoint restore (`restoreFromYDoc`) installs the snapshot's projected nodes
directly, never a serialize/parse round trip, so attributes the codec does not
spell survive; a `code` snapshot is rebuilt from its text with the current
filetype as `language`. Every whole-document replacement serializes its staged
copy before journal admission, so a snapshot the codec can't spell fails with
the journal and live document untouched. Restore matches the old round trip
only for Markdown-generated content. Native snapshots keep structure it used to
normalize: a whitespace-only paragraph followed by an empty one stays two
paragraphs (the old path collapsed them to one empty paragraph; both serialize
to the same empty Markdown), and a non-string code-block `language` such as
`42` stays numeric instead of reparsing to a string.
Schema projection always runs on a private `gc: false` clone (with the source
client identity restored after state copy): normalization can repair that clone,
but serialization cannot mutate its input Y.Doc. Any clone update during
projection is an `collab.schema` / `serialize.anomaly_observed` smoke alarm,
including insert-only normalization; its best-effort EventSink delivery never
fails the projection. The event carries schema version, node types, and clock
counts, never prose.

`domain/agent-edit-runtime.ts` is the one place a `mdxCodec` is built. The
composition root passes a required `DocumentLinkScopes` port
(`domain/ports/document-link-scope.ts`, adapter in context's
`adapters/document-link-scope.ts`); compositions with no project tree
(in-memory, tests) pass `createStaticDocumentLinkScopes()`. Every serialize call
takes a holder-bound scope that spells stored links and sources: a ref-bearing
link as its target's current path in the holder's view, an `asset:<documentId>`
source as its manuscript-relative path, anything else as stored. Parse is pure
syntax; ref assignment (agent-edit `assignLinkRefs`, which also turns a known
manuscript image path into `asset:<id>`) binds what was written.

**Whole-document writes prepare outside, apply inside** (`domain/link-binding.ts`,
contract §6.2). The engine's writes (`setMarkdown`, `writeDocument`,
`seedFromMarkdown`) take a `PreparedWrite`, never a Markdown string, and never
parse. A `LinkBinder` makes it, before the caller opens any transaction:
`bindMarkdown` opens the holder's scope (the document, or the project and the
address a document about to be created will have), parses, prepares, assigns
fresh or against the holder's current document (`against: "current"`: every
link that stays corresponds to itself and keeps its ref, so an overwrite or a
host append keeps refs verbatim), and registers the ahead refs it minted.

A prepared write is a mutation, not a desired state. Prepared against the
current document, it keeps the base it read through the coordinator (its state
vector) and carries the Yjs update that turns that base into the bound result,
diffed with `updateYFragment` (`applyDocumentDiff`), so unchanged blocks keep
their items. Append keeps the current document's own nodes for the blocks the
appended text left alone, so it is an insertion after the base's last block.
Applying merges the update into the live document: a writer's edit, unlink or
retarget admitted between prepare and apply stays, in either order. A
document that no longer holds the base (`containsBase`, or unresolved
dependencies after applying) is `stale_generation`, for the caller to prepare
again. Fresh writes (seed, import, create, upload) have no base and need a
document with no blocks. A prepared write also certifies its holder (`document`
by id, `new` by the canonical address it will have, or `static`): the engine
refuses to apply it to any other document, and ContextFS checks the path's
occupant under its namespace lock.
Registration opens a root transaction that takes namespace keys; inside a
command transaction that already holds them it would wait on itself forever,
invisibly to PostgreSQL. So `bindMarkdown` throws
`LinkBindingInsideTransactionError` inside any transaction, and a door that
forgot to hoist fails at once. `bindStatic` is for link-free text fixed in code
(a project's first chapter, seeded inside the bootstrap transaction); it throws
if the text names anything. `writeDocument` routes an actor's write in a
thread (and every agent write) through the edit core's create-overwrite with
`WriteContext.prepared`, which merges the prepared update into its runtime and
records it as that actor's mutation; a writer's save outside a thread merges
it directly. There is no string-transform write: host append binds
`current + appended` itself. Seed, import and create bind fresh (pass 3 only).

The codec asks synchronously, so the tree is read per operation, never cached.
`within(key, op)` opens a snapshot keyed by project and reader (the account a
door names, else its thread's account, else the project owner; and the thread
it reads in) and binds it with `AsyncLocalStorage`; nothing loads yet. Each operation then calls
`prepare({ holders, docs, stored, refs, addresses, written })` with what its next
synchronous block names: refs and `asset:` ids are extracted from the Yjs docs
(agent-edit `ports/stored-link-extraction.ts`), and one batch loads settlements, rows by
id and rows at exact or extension-omitted addresses, readability through the
file policy's list path, and manifest membership only when a row needs it.
Membership is the same authority ContextFS lists through and is required (DB
suites pass `everyRowMembership` or the real manifest); its failure propagates.
A view's own manifest decides presence: a draft that removed a live document
lacks it, and the live set only tells live from draft-only. A view whose
membership was never loaded is a miss, not an absence.
`holder({ documentId, view })` returns the synchronous scope only from an open
snapshot; it keeps that snapshot, so work deferred past the operation spells
from it.

`domain/document-link-scope-doors.ts` wraps every door that serializes: the
markdown engine (each method prepares after loading its doc), the edit core
(`read`/`write` by grant project and principal, reversal by document in its
thread; agent-edit binds its codec per command through `DocumentLinksPort`),
the branch peer (effective Markdown, hashlines and revision, in the reader's
thread), the reply's save (by thread),
live turn reversal and offline reconciliation. Draft preview owns one
enclosing scope for both sides, the draft spelled in its Work's view. ContextFS
search owns one for all matching documents in its source. Branch push opens
its scope before branch locks and prepares its trail docs under them; its
settlement keeps its own scope. Wrappers name every method, so a new method
does not compile until its scope is decided. A nested `within` for the same
project and reader reuses the enclosing snapshot only while that operation is
still running, and never one read as another account or in another (or no)
thread; a timer that inherited a settled snapshot opens a fresh one. A move
that lands after a prepare shows only in the next snapshot.

The view is explicit everywhere. The engine's `serializeDocument` and
`serializeVersionedDocument` take it, and an effective read names its version
(`EffectiveReadVersion`: live, or draft with its Work). The thread pool routes
each model call's view on `WriteContext.linkView`: the destination it chose
for a read or write, and for an undo or redo the side whose history it
reverses (a draft side in the Work whose draft holds that history). At a
reply's save each document spells in the destination it was pinned to. A
thread core asked to spell without a routed view throws.

A picture never fails its document. The `asset:` rule reads the snapshot's
rows but, as the shipped image rule always has, not readability or
membership. An id with no document spells as its `asset:` ref. A deleted image keeps its last path only while that path reads
back to it alone (no live image and no other deleted image there); otherwise it
spells as its ref, so a chapter saved while the image is gone reconnects on
restore. Spelling outside every scope uses stored bytes and is reported
(`serialize.link_unscoped`); a ref or address the snapshot never loaded is
`serialize.link_snapshot_miss`, a throw under test only when no door prepared
the snapshot.

**Durable whole-document projections route through this engine.** Push
completion and trail forward actions inject `DurableProjectionSerializer`
(`Pick<MarkdownDocumentEngine, "serializeDocument">` in
`domain/ports/durable-projection.ts`). They never accept a schema-blind
`{model, codec}` bag. `PreparedPushCommit` must not carry a prepared markdown
projection or live snapshot; settlement derives the projection from the durable
journal at completion time. This keeps serialization inside the fenced
settlement cut and preserves verbatim code-document output.

Trail forward actions serialize from a **scratch** `Y.Doc` they apply the
committed update to, before mutating the shared live document — never from the
live doc, which a WebSocket mutation may change mid-serialize (LOCK-WS).

`isCorruptDurableProjectionError` is the single narrowing predicate:
`DocumentSyncError` with `code: "corrupt_state"` (a registered non-tracked
filetype on a tracked journal) permanently blocks live settlement via
`PendingSettlementStore.block`. Any other throw is transient: the settlement
stays pending and retryable. Do not block on every projection throw.

**Projection effects preserve caller-specific ordering.** Ordinary durable
writes start document activity and markdown projection together and settle both
before reporting the first failure. Push completion instead runs projection,
all-thread activity, explicit Work activity, active-document project lookup, and
project activity in that order. The Drizzle adapter resolves the ambient
transaction for every port operation so a completion retry rolls these
read-model writes back with journal, lineage, mutation, and outbox writes.

Filetype resolution uses the contracts disposition registry. Missing or
unregistered persisted values deliberately use the document schema; a registered
binary/custom value on a tracked journal returns `corrupt_state` from
Result-returning surfaces instead of escaping as a rejected promise.

Invariant: a document's journal state must always be valid under the schema the
client mounts for its filetype. All seed and write paths go through the
schema-aware engine rather than hand-building fragment content. A new
document's first seed is installed as its
generation-1 checkpoint with no admitted journal mutations. Seeding is strictly initialize-only: any
existing admission or checkpoint makes later attempts successful no-ops. A seed
is reconciled into an already-open live room before success returns, and a stale
room checkpoint at the same journal cut cannot replace it. The context caller contract is documented in
[the context domain](../../context/.context/CONTEXT.md).

Writer admission rejects reserved client IDs and insertion or deletion in the
reserved provenance namespace before durable append and Yjs apply. The
reserved namespace is server-owned certification state, not a client write
surface.

WebSocket admission compares the bundle's declared schema version with the
specific live or Work-draft branch head before sync. The check runs per
connection because Hocuspocus deduplicates document loads. An unstamped live
head passes. A server/head major mismatch in either direction closes first with
`4407 document-schema-stale`; otherwise a client whose `(major, minor)` is
behind the head closes with `4406 client-schema-superseded`. Patch differences
never gate. Load-time `DocumentSchemaMajorMismatchError` handling retains the
typed 4407 close as a race backstop.

Domain and port contracts carry `CollabSchemaVersion` triples. Drizzle adapters
alone encode them as order-preserving packed integers and decode them on read.
Head and branch persistence use monotonic `greatest()` stamps so a rolled-back
server cannot lower the durable version.

Physical close delivery, request parsing, and Hocuspocus hook termination
belong to the [server transport boundary](../../../lib/.context/CONTEXT.md).
