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
syntax; writes run `bindSources` (agent-edit) after parsing, which turns a
known manuscript image path into `asset:<id>`, so an image's identity survives
a move while Markdown keeps a readable path.

The codec asks synchronously, so the tree is read per operation, never cached.
`within(key, op)` opens a snapshot keyed by project and reader (the project
owner unless the door names the account it acts for) and binds it with
`AsyncLocalStorage`; nothing loads yet. Each operation then calls
`prepare({ holders, docs, refs, addresses, written })` with what its next
synchronous block names: refs and `asset:` ids are extracted from the Yjs docs
(`domain/stored-link-extraction.ts`), and one batch loads settlements, rows by
id and rows at exact or extension-omitted addresses, readability through the
file policy's list path, and manifest membership only when a row needs it.
`holder({ documentId, view })` returns the synchronous scope; it keeps its
snapshot, so work deferred past the operation spells from it.

`domain/document-link-scope-doors.ts` wraps every door that serializes: the
markdown engine (each method prepares after loading its doc), the edit core
(`read`/`write` by grant project and principal, reversal by document; agent-edit
binds its codec per command through `DocumentLinksPort`), the branch peer
(effective Markdown, hashlines and revision), the reply's save (by thread),
live turn reversal and offline reconciliation. Draft preview owns one
enclosing scope for both sides, the draft spelled in its Work's view. ContextFS
search owns one for all matching documents in its source. Branch push opens
its scope before branch locks and prepares its trail docs under them; its
settlement keeps its own scope. Wrappers name every method, so a new method
does not compile until its scope is decided. A nested `within` for the same
project and reader reuses the enclosing snapshot only while that operation is
still running; a timer that inherited a settled snapshot opens a fresh one. A
move that lands after a prepare shows only in the next snapshot.

A picture never fails its document. An id with no document spells as its
`asset:` ref. A deleted image keeps its last path only while that path reads
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
