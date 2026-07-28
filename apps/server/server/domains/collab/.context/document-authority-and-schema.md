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

**Durable whole-document projections route through this engine.** Push
completion derives the projection at settlement through
`DurableProjectionSerializer`; `PreparedPushCommit` must not carry a prepared
markdown projection or live snapshot. This keeps serialization inside the
fenced settlement cut and preserves verbatim code-document output.

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
