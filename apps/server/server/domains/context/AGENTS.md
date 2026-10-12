# domains/context

Agent-readable/writable content addressed by context URIs. Context schemes split
into durable Project content (`manuscript://`, `kb://`, `unfiled://`), authenticated personal
content (`user://`), and owned material: a named Work's `scratch://@slug/` and
`uploads://@slug/`, No Work's `uploads://@/`, and a No Work chat lineage's
`scratch://@/c12/`. Bare paths default to `manuscript://`.

**Scratch has two owner kinds.** `scratchOwnerFor(thread, work)` is the one rule
for bare `scratch://` and for the file policy's own-Scratch term: the named Work,
or the No Work chat's lineage (`rootThreadId`). The locked No Work row has no
Scratch source; never route Scratch to it. A lineage handle names the first chat,
trashed included, never a fork. Only the AI creates lineage notes; writer create,
intake and moves into a lineage are refused. Lineage provisioning and
trash/restore liveness belong to `adapters/lineage-scratch-lifecycle.ts`; reuse
it rather than adding another guard. A hidden-to-live lineage transition settles
waiting ahead refs under its namespace lock in the same transaction. A lineage
root names Scratch ownership, never a reader: draft visibility for link answers
comes from the selected Work's draft tree view (No Work when a request names a
lineage), so never pass `rootThreadId` as the viewing thread.

`skills://` (a thread's skill files, D52) is not a context scheme: it is
model-only, resolved by `runtime/loop/skill-files.ts` per thread binding, and
has no documents. Don't add it to `CONTEXT_URI_SCHEMES`.

Single unified `ContextPort` — callers resolve through `contextPortForThread`,
never scheme-specific adapters directly.

Wire-qualified Work URIs use `@slug`. Parsing produces grammar-only `WorkSlug`;
project resolution couples an exact non-deleted Work ID and persisted slug into
the opaque authority used for stable serialization and adapter dispatch.
`thread_works` membership selects the thread's primary Work but never grants
context access.

Who may read or change a file is the [file policy](../file-policy/.context/CONTEXT.md),
asked by the route or tool before it calls this domain. Context storage is a
write seam: its transactions start with `lockSeamWorks`, which confirms the
caller's bound edit grants before namespace and source advisory locks
(`requireLockedActiveWorks`). Content mutations also still require their own
Works to be active under that row lock, grant or not. Context commands translate lifecycle loss to
`context_unavailable`, not a storage error.

Scheme capabilities are declared once in `ports/context-adapter.ts` and enforced
by the router. F0 owns Uploads authority, provisioning, and resolution; F4 owns
the actual `UploadIntake` lifecycle. `uploads://` does not allow general clients
to create context entries or directories, so binary intake is flat;
`scratch://` is the authoring space and accepts nested intake paths.

Text creation and writes must resolve the document filetype and use the collab
document engine. Never seed Yjs by hand with an assumed markdown schema.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts, URI invariants,
and ContextFS details.

→ [`domains/collab`](../collab/AGENTS.md) owns schema-aware Yjs codecs and
journaling.

## HTTP routes

Filesystem mutation/content routes live under
`routes/api/projects/[projectId]/context/[scheme]/`. Most use `_helpers.ts` for
auth, project ownership, scheme/Work resolution, the file-policy grants
(`edit` runs a write under them), canonical error translation, and URI
construction. Writer-facing mutation input goes through the shared
reason-coded validators in `lib/context-mutation-validation.ts`.

`move.post.ts` is intentionally a thinner shell over `lib/context-move-route.ts`:
the route core resolves every requested locator to exact project/lineage/Work
authority before it calls `ContextPort.commitWriterLocation`. Optional
`destinationParent` binds a folder ID or area root; URI-addressed callers omit
it. A folder destination resolves again under the move transaction's namespace
locks. `createFolders` is a validated name suffix ensured beneath the anchor's
current home in that transaction; the route accepts it on any identity move,
and by convention only the app's linked creation sends it. A missing anchor
never recreates its old path. Missing, terminal or denied identity
destinations return typed `destination_missing` repair evidence; a
URI-addressed move keeps path resolution and its ordinary errors. Receipts retain
the selected parent identity, creation suffix and original URI command. Proven occupation
returns the current collision locator; path-only commands must match the
requested locator. Stale source/target plans return a retry result instead.

`create.post.ts` returns the shared `CreateContextEntryResult` for both files
and folders. A namespace conflict is HTTP 409 with top-level `status`, `uri`
and the proven `occupantKind` (when known), not a generic HTTP error envelope.

`create-untitled.post.ts` accepts a client-minted document ID. Idempotent retries
recover that ID across all project and authorized Work schemes, returning its
canonical scheme/path/Work authority. Returned `name` values are full filenames.

Routes: `read.get.ts`, `create.post.ts`, `create-untitled.post.ts`,
`move.post.ts`, `delete.post.ts`, `upload.post.ts`, and the
identity-bound `upload.delete.ts`. Upload routes delegate all authority,
classification, collision, persistence, and deletion decisions to `UploadIntake`.
Composer reference removal never calls the separate upload-delete route.

Browser bookmarks use `address.get.ts`, a current-occupant-first lookup with
previous paths pointing directly to stable document IDs. Chat links use previous locations only when there is no current occupant;
editor links carry a stable ref and never consult them. Every successful namespace claim consumes the exact old
alias in the same transaction; source provisioning is not a path claim.

Metadata browsing uses the sibling catalog routes: complete compact snapshot,
whole-commit changes, direct children, and stable-ID/canonical-URI lookup. Every
single-source command is owned by `ContextFS`; whole-tree commands are owned by
`ContextTreeMover`. Lazy source resolution and stores only join that ambient
Drizzle transaction, and typed failures roll it back; content-only
Yjs/projection changes do not publish.
Catalog files preserve persisted tracked or binary classification. The context
domain emits best-effort truth-free wake hints after commit through the existing
authenticated thread socket; focus and bounded polling repair dropped hints.
The catalog is the live tree view, the same one ContextFS reads: a draft's
hidden rows and folders never reach it. Draft Apply reconciles every source
its tree step placed into or moved out of inside the completion transaction,
warm or recovered (collab's `drizzle-draft-tree-step.ts`, F23), so a replica
replaying from a pre-Apply cursor learns the revealed, restored and renamed
nodes. Discard's kernel (collab's `drizzle-draft-discard.ts`) reconciles every
source whose hidden nodes it tombstoned inside its own transaction the same way,
for the writer's Discard and Work purge alike. Source refreshes publish in the
mutating transaction.
Routes authenticate and translate transport only; catalog transaction and replay
policy live in the context domain.

Stored links resolve in batches at `POST /api/projects/[projectId]/links/resolve`
(`(ref, href)` pairs, answers in request order). A `doc:`/`ahead:` ref resolves
through one prepared link scope keyed by (project, requesting account); a ref the
reader cannot reach answers `gone` with no location, because a ref is not a
capability. A hidden document answers `inDraft` with the `draft` that names it
and that draft's path. The route pins the holder (`holderDocumentId` wherever it
now sits, else the one document at `baseUri`), only one the reader may name and
read, so its own bindings answer its ahead refs first (`holderBound`), and returns
`holderUri` when the holder moved. One it can't pin (unknown, ambiguous, or not
the reader's) answers ahead refs without bindings and says `holderUnresolved`,
with no holder location, never silently. Ref-less links keep the address resolver; previous locations
apply only when `baseUri` is null (chat).

**A move writes nothing into any document.** Links name documents, so a rename
re-spells on read. Moves flush durable link derivation (which also registers
client-minted ahead refs) before namespace locking, then row-lock every mutated
document (moved identities and any overwrite victim) with
`lockMovedDocumentRows`, sorted, `FOR NO KEY UPDATE`. Never use `FOR UPDATE`
there: journal FK inserts must remain compatible. After the DML the move
settles ahead refs waiting at its destinations (move-in arrival), then counts the
note's `linkUpdate`: occurrences in the request project's live holders (visible in the live tree view) whose ref names a moved document
(`links/move-link-count.ts`). Hidden draft holders are excluded by tree identity status.

Every arrival (tracked create, upload, move-in, Work restore, Apply) settles ahead
refs once, against its final tree, through `DocumentArrivals`; see
[`.context/CONTEXT.md`](.context/CONTEXT.md#ahead-refs-and-arrivals).

Lineage source hiding is reversible authority loss (`lineage_hidden`), not document
deletion. Project-final availability must preserve that distinction so cached
Scratch resources can return on chat or Work restore. Independent document
tombstones still report deletion while their lineage is hidden;
`deletedByWorkId` identifies reversible cascade-owned tombstones. Folder delete
commands validate the supplied folder node ID before recursive mutation.
