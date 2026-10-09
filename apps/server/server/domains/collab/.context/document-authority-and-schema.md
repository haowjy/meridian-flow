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

`domain/agent-edit-runtime.ts` is the one place a `mdxCodec` is built, so it is
also the one place image paths enter serialization. The composition root passes
a required `DocumentAssetPaths` port (`domain/ports/document-asset-paths.ts`);
compositions with no project tree (in-memory, tests) pass
`NO_DOCUMENT_ASSET_PATHS`. The resolver translates `asset:<documentId>` to a
manuscript-relative path on serialize and back on parse, so an image's identity
survives a move while markdown keeps a readable path.

The codec asks synchronously, so the paths are loaded per operation, never
cached: `within(project, op)` reads every manuscript image (deleted ones at
their last location) in one query and binds them to the operation with
`AsyncLocalStorage`. `domain/asset-path-scope.ts` wraps every door that
serializes: the markdown engine, the edit core (`read`/`write` by grant
project, reversal by document), the branch peer, the reply's save (by thread),
live turn reversal, draft push and its settlement, and offline reconciliation.
Draft preview owns one enclosing scope for both live and draft serialization.
ContextFS search owns one for all matching documents in its source; it supplies
those document IDs with the first document as the project anchor, so nested
reads need neither another image-tree load nor another project lookup.
Wrappers name every method, so a new method does not compile until its scope is
decided. A nested `within` for the same project reuses the enclosing scope only
while that operation is still running; a timer that inherited a settled scope
loads fresh. Effective Markdown and hashline reads load before branch locks;
Apply resolves branch identities and paths first, then revalidates all branch
snapshots under their locks. The snapshot precedes locks, so a move that
lands in between, or one the operation makes itself, shows only in the next
scope.

A picture never fails its document. An id with no document spells as its
`asset:` ref. A deleted image keeps its last path only while that path reads
back to it alone (no live image and no other deleted image there); otherwise it
spells as its ref, so a chapter saved while the image is gone reconnects on
restore. A picture serialized outside every scope spells as its ref and is
reported: `serialize.asset_path_unscoped` in production, a throw under test.

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
