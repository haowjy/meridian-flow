# Yjs State Lifecycle Analysis

## Problem Statement

Meridian currently has two writable representations of document text:

- `documents.content` / `documents.ai_content` in the docsystem path
- `documents.yjs_state` in the collab path

Those writes are not coordinated. A document can be created or updated through REST without touching `yjs_state`, while collab readers and snapshot code prefer `yjs_state` once it exists. That creates three concrete failure modes:

1. Snapshots can be empty when `yjs_state` is still `NULL`.
2. A later WebSocket session can ignore newer REST `content` if stale `yjs_state` already exists.
3. Server-side features that assume CRDT ancestry can operate on the wrong base state.

## Codebase Context

- Document creation persists only text columns. `backend/internal/service/docsystem/document.go:122-142` builds a `Document` with `Content`, and `backend/internal/repository/postgres/docsystem/document.go:36-54` inserts `content` and `ai_content`, but not `yjs_state`.
- REST update also only updates text columns. `backend/internal/service/docsystem/document.go:270-302` mutates `doc.Content`, and `backend/internal/repository/postgres/docsystem/document.go:307-340` writes `content = $4, ai_content = $4`, again without touching `yjs_state`.
- The collab runtime treats persisted Yjs as authoritative when present. `backend/internal/service/collab/session_manager.go:278-325` loads `yjs_state`; if non-empty it applies that state and does not consult `content`. It only bootstraps from `content` when `len(state) == 0`, then persists the new CRDT state.
- Snapshot creation reads only `yjs_state`. `backend/internal/handler/collab_snapshot.go:113-121` loads state directly from `stateStore.LoadState(...)` and saves that snapshot.
- The collab store already models `SaveState` as the coordinated write path. `backend/internal/repository/postgres/collab/document_store.go:100-124` persists `yjs_state`, `content`, and `ai_content` together.
- The AI projector already documents the intended invariant: it calls the base Yjs state "authoritative", bootstraps from markdown only when empty, and persists the bootstrapped state "to establish CRDT lineage." See `backend/internal/service/collab/ai_content_projector.go:42-55` and `:96-156`.

Taken together, the repository already leans toward this model:

- `yjs_state` is the canonical editable state for collab-aware features.
- `content` and `ai_content` are derived projections that should stay aligned with that base.

The current bug is that the REST document path still writes projections directly.

## Best Practices From Yjs Ecosystem

### 1. Lazy initialization on first access is common

- Hocuspocus loads a document in `onLoadDocument`, and its persistence guide explicitly shows `loadFromDatabase(...) || createInitialDocTemplate()` during document load, not at some earlier REST creation step.[1]
- Hocuspocus describes `onLoadDocument` as running "during the creation of a new document" and `onStoreDocument` as the debounced persistence hook.[2]
- Y-Sweet's quickstart creates or fetches the collaborative document in the auth flow with `getOrCreateDocAndToken(docId)`, which is an inference that document materialization commonly happens on first authenticated access/open rather than at metadata creation time.[3]
- Liveblocks' default-value guidance says to wait for the Yjs provider to sync, then only seed content if the shared doc is empty; setting editor defaults outside the synced Yjs flow causes duplication.[4]

Conclusion: lazy first-load bootstrap is normal. What is not normal is keeping a separate text column as an independent source of truth after the CRDT exists.

### 2. The CRDT/binary state is normally the source of truth

- Yjs documents are encoded as binary updates, and the official docs say those updates should be sent to peers or stored in a database.[5]
- Hocuspocus explicitly warns not to store JSON and recreate the Yjs document on each connection; it says JSON/HTML should be treated as a "view" rather than the data source, and raw JSON-to-Yjs conversion should be used for migration or initial import only.[2]
- Hocuspocus' database extension requires returning the same `Uint8Array` that was stored, warning that creating a new Y.Doc would create new history and duplicated content.[6]
- Liveblocks says its platform must store Yjs document data for realtime sync, conflict resolution, offline support, and document loading. If you want your own DB copy, their recommended pattern is webhook-based duplication from the Yjs source, not parallel independent writes.[7]
- Y-Sweet positions itself as "a realtime CRDT-based document store, backed by object storage," with persistence built into the sync backend.[3]

Conclusion: the standard pattern is one authoritative CRDT state plus optional derived/exported views. Parallel writable representations are a migration bridge, not a stable end state.

## Alternative Approaches

### Approach A: Minimal fix at snapshot creation time

Behavior:

- If `yjs_state` is empty when creating a snapshot, bootstrap a Y.Doc from `content`.
- Persist that bootstrapped state before snapshotting so future Yjs updates share the same ancestry.

Pros:

- Smallest change in behavior.
- Fixes the immediate "empty snapshot before first WS session" bug.
- Matches Meridian's existing bootstrap logic in `session_manager` and `ai_content_projector`.

Cons:

- It is a special case in one read path.
- It does nothing for stale-but-non-empty `yjs_state`.
- It still leaves REST PATCH and collab writes diverging.
- Snapshot creation becomes a hidden mutating operation, which is a little surprising.

Codebase fit:

- Good as a stopgap because the same bootstrap pattern already exists elsewhere.
- Not sufficient as the long-term lifecycle because it only patches one symptom.

### Approach B: Bootstrap `yjs_state` eagerly at document creation time

Behavior:

- Whenever a document is created through REST, also create the initial Yjs document and persist `yjs_state` immediately.

Pros:

- Every document has CRDT lineage from birth.
- Snapshots, AI projection, offline proposal application, and first WS connect all see a consistent base state.
- Fewer `NULL`/empty-state branches across the backend.
- The runtime model becomes easier to explain: "all documents are collaborative documents, whether or not a WS client has connected yet."

Cons:

- Slightly increases document-create complexity by pulling Yjs bootstrap into the doc create path.
- Adds a small one-time CPU/storage cost for documents that may never use collab.
- Still does not solve divergence if REST PATCH keeps writing `content` directly afterward.

Codebase fit:

- Better than snapshot-time bootstrap because Meridian already has multiple server-side consumers that want a CRDT base, not just WebSockets.
- The performance cost should be modest for markdown documents; this is a one-time encode on create, not a per-keystroke cost.

### Approach C: Make `yjs_state` the only writable content source after bootstrap

Behavior:

- Bootstrap `yjs_state` at create time.
- Route all later content mutations through a collab-aware write path that updates `yjs_state` and derived text projections together.
- Alternatively, forbid generic REST `content` PATCH for collab documents and replace it with an explicit import/replace operation that rewrites `yjs_state` canonically.

Pros:

- Removes the root cause instead of treating symptoms.
- Aligns with Yjs, Hocuspocus, Liveblocks, and Y-Sweet architecture.
- Keeps snapshots, WS sessions, AI proposal tooling, and REST reads on one canonical lineage.
- Preserves correct CRDT ancestry, which matters for merging and update application.

Cons:

- Larger design change than the minimal fix.
- REST PATCH can no longer be a naive SQL update; it must either:
  - load/apply/save through Yjs, or
  - become a specialized "replace document content" operation with explicit semantics.

Codebase fit:

- Best fit with Meridian's current collab store API because `SaveState(...)` already persists the coordinated state.
- Also fits the comments in `ai_content_projector.go`, which already describe authoritative base Yjs state and CRDT lineage.

## Direct Answers

### 1. Is lazy Yjs initialization common?

Yes. Lazy initialization on first document open/load/sync is common.

Evidence:

- Hocuspocus initializes through `onLoadDocument` and persists through `onStoreDocument`.[1][2]
- Liveblocks recommends seeding initial content only after the Yjs provider syncs and only if the shared doc is empty.[4]
- Y-Sweet exposes `getOrCreateDocAndToken`, which strongly suggests first-access creation is a normal pattern.[3]

Important qualifier:

- "Lazy init" does not imply "text column remains authoritative until a user opens WebSocket." In the examples above, once the collaborative doc exists, the Yjs state is the canonical stored state.

### 2. When REST and CRDT state coexist, what is the standard reconciliation pattern?

The standard pattern is:

- CRDT state is the source of truth.
- REST/API/database views are derived exports or mirrored copies.
- If a non-collab API wants to mutate content, it must do so by updating the CRDT state, not by independently editing a plain-text shadow column.

The Hocuspocus docs are especially direct here: JSON/HTML should be treated as a view, not the data source, and repeated reconstruction of Yjs state from that view causes merge/history problems.[2][6]

For Meridian, that means `content` should be treated as a projection of `yjs_state`, not a sibling authoritative field.

### 3. Should Meridian bootstrap `yjs_state` from `content` at snapshot creation time if `yjs_state` is NULL?

Yes, as an immediate safety fix, but only as a stopgap.

Best version of this fix:

- If `LoadState()` returns empty, load `content`, build a Y.Doc, persist the new `yjs_state`, then snapshot that state.

Why:

- It fixes the empty-snapshot bug immediately.
- It matches existing Meridian bootstrap behavior in `session_manager` and `ai_content_projector`.
- Persisting the bootstrapped state preserves CRDT lineage; generating a one-off snapshot from text without persisting would leave the main document state inconsistent.

Tradeoffs:

- Snapshot creation becomes a write operation.
- It does not address stale non-NULL `yjs_state`.
- It risks hiding the larger architectural issue if treated as the whole solution.

### 4. Should Meridian bootstrap `yjs_state` at document creation time instead?

Yes. This is the better default lifecycle.

Why:

- It removes the "brand new doc has no CRDT lineage" gap for every downstream feature.
- It simplifies assumptions for snapshots, AI proposal projection, offline update application, and first WebSocket connection.
- The overhead is low relative to the simplification gained: one initial Y.Doc creation and one binary encode per document.

Tradeoffs:

- Slightly more work in the create path.
- Some documents may never use realtime collaboration, so you pay a small up-front cost for those too.

My assessment:

- In this codebase, the simplification is worth it. Multiple services already assume a CRDT base exists or can be bootstrapped. Eager bootstrap makes that assumption consistently true.

### 5. Should REST PATCH also update `yjs_state`?

Yes, if REST PATCH is going to remain a supported content mutation path.

The current "let them diverge and reconcile on next WS connect" pattern is not acceptable here because Meridian does not actually reconcile on next connect:

- `session_manager.loadState()` prefers any existing non-empty `yjs_state` and ignores `content` in that case (`backend/internal/service/collab/session_manager.go:278-291`).
- REST PATCH updates `content` directly (`backend/internal/service/docsystem/document.go:270-302`, `backend/internal/repository/postgres/docsystem/document.go:307-340`).

So the actual behavior is:

- stale `yjs_state` wins
- newer REST `content` loses

That is data divergence, not reconciliation.

If Meridian keeps REST PATCH for content, it should:

1. Load the canonical Yjs state (or bootstrap it if empty).
2. Apply the requested content replacement/change through Yjs-aware logic.
3. Persist `yjs_state`, `content`, and `ai_content` together through the collab store.

If that is too heavy for generic PATCH semantics, then a cleaner product decision is:

- stop allowing generic REST content PATCH on collab-backed documents, and
- replace it with an explicit "replace/import document content" endpoint that rewrites canonical Yjs state on purpose.

## Recommendation

Recommended target state:

1. Treat `yjs_state` as the canonical editable representation.
2. Treat `content` and `ai_content` as projections derived from that state.
3. Bootstrap `yjs_state` at document creation time.
4. Update `yjs_state` on every later content mutation path, including REST PATCH, or remove direct REST content mutation.

Recommended rollout:

### Short term

- Add defensive bootstrap-and-persist when snapshot creation sees empty `yjs_state`.
- Audit other non-WS server paths and make them do the same whenever they require canonical Yjs state.

### Medium term

- Bootstrap `yjs_state` eagerly at document creation.

### Long term

- Remove dual-write authority. Only one path should author document text: the CRDT state.

This is the cleanest fit for Meridian because the repository already has:

- a coordinated `SaveState(...)` abstraction,
- comments that call Yjs the authoritative base state,
- server-side features that need stable CRDT ancestry.

## Open Questions

1. What should REST PATCH mean semantically for collaborative documents?
   - Full replacement of the shared text?
   - Best-effort textual patch?
   - Disabled once a document is collab-enabled?

2. Are there document classes in Meridian that should never incur Yjs bootstrap cost?
   - If yes, the system may need an explicit "collab-enabled" flag.
   - If no, eager bootstrap is simpler.

3. Do snapshots need to capture only canonical base state, or base state plus pending proposal projection?
   - Current code snapshots base `yjs_state`, which seems correct, but it is worth making explicit.

## Sources

[1] Hocuspocus persistence guide: https://tiptap.dev/docs/hocuspocus/guides/persistence

[2] Hocuspocus hooks guide (`onLoadDocument`, `onStoreDocument`): https://tiptap.dev/docs/hocuspocus/server/hooks

[3] Y-Sweet docs / quickstart: https://docs.y-sweet.dev/

[4] Liveblocks guide on initial/default value with Yjs: https://liveblocks.io/docs/guides/setting-an-initial-or-default-value-in-tiptap

[5] Yjs document updates API: https://docs.yjs.dev/api/document-updates

[6] Hocuspocus database extension: https://tiptap.dev/docs/hocuspocus/server/extensions/database

[7] Liveblocks guide on syncing your own database with Yjs: https://liveblocks.io/docs/guides/can-i-use-my-own-database-with-yjs

[8] Liveblocks Supabase sync guide: https://liveblocks.io/docs/guides/how-to-synchronize-your-liveblocks-yjs-document-data-to-a-supabase-postgres-database

[9] Y-Sweet + Supabase demo architecture: https://github.com/jamsocket/y-sweet-supabase-demo
