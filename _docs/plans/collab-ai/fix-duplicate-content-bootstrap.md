# Plan: Fix Duplicate Content on Empty Yjs State Bootstrap

## Problem

Documents get duplicate content when `yjs_state` is NULL in the database. Two clients concurrently calling `bootstrapTextIfEmpty()` each insert the same REST content independently — Yjs CRDT merges them as two separate inserts → duplicated text.

## Solution

Move first-write bootstrap from client to server. Add a subscription generation guard on the client as defense-in-depth.

---

## Task 1: Server-Authoritative Bootstrap

**Goal:** When `loadState()` finds empty `yjs_state` but the document has non-empty `content`, initialize the Y.Doc server-side before any client connects.

### Backend Changes

#### 1. Add `LoadContentForBootstrap` to DocumentStore interface and implementation

**File:** `backend/internal/domain/services/collab/collab.go`
- Add new method: `LoadContentForBootstrap(ctx context.Context, docID string) (string, error)`

**File:** `backend/internal/repository/postgres/collab/document_store.go`
- Implement `LoadContentForBootstrap`: `SELECT content FROM documents WHERE id = $1 AND deleted_at IS NULL`
- Return empty string if content is NULL

#### 2. Bootstrap Y.Doc in `loadState()` when yjs_state is empty

**File:** `backend/internal/service/collab/session_manager.go` — `loadState()` (line 273-290)

Current behavior: if `len(state) == 0`, return nil (empty doc).

New behavior:
```
if len(state) == 0:
  content, err := s.store.LoadContentForBootstrap(ctx, s.docID)
  if content != "":
    // Initialize Y.Doc with REST content
    yText := s.doc.GetText("content")
    yText.Insert(0, content)  // or equivalent y-crdt API
    // Persist the bootstrapped state immediately so subsequent sessions
    // don't re-bootstrap
    state, _ := safeEncodeStateAsUpdate(s.doc)
    textContent := yText.ToString()
    s.store.SaveState(ctx, s.docID, state, textContent, textContent)
  return nil
```

Key points:
- This runs under the session manager's lock (only one session created per doc)
- The `Acquire()` double-check pattern (line 96-101) prevents concurrent bootstrap
- Persisting immediately means the second session load gets valid yjs_state

#### 3. Add unit tests

**File:** `backend/internal/service/collab/session_manager_test.go` (new or extend existing)
- Test: `loadState` with empty yjs_state + non-empty content → Y.Doc contains content, state is persisted
- Test: `loadState` with empty yjs_state + empty content → Y.Doc stays empty
- Test: `loadState` with valid yjs_state → normal path unchanged

### Frontend Changes

#### 4. Remove client-side bootstrap

**File:** `frontend/src/core/cm6-collab/sync/runtime.ts`
- Keep `bootstrapTextIfEmpty()` method but add a deprecation comment — it's now a no-op fallback since server handles bootstrap
- OR: Remove it entirely and update callers

**File:** `frontend/src/features/documents/hooks/useDocumentCollab.ts`
- Remove `didBootstrap` flag and `tryBootstrap()` function (lines 142, 173-179)
- Remove `tryBootstrap()` calls from `onInitialSyncComplete` (line 191) and IDB `.finally()` (line 429)
- Keep `initialContent` in the options for now (no-op, can be cleaned up later)

---

## Task 2: Subscription Generation Guard (Defense-in-Depth)

**Goal:** Prevent repeated `doc:subscribed` events from re-triggering `startSync()` for the same runtime lifecycle.

### Frontend Changes

#### 1. Add `didStartSync` guard to runtime

**File:** `frontend/src/core/cm6-collab/sync/runtime.ts` — `startSync()` (line 146)
- Add `private didStartSync = false` field
- In `startSync()`: if `didStartSync` is true, log and return early
- Set `didStartSync = true` at the start of `startSync()`

#### 2. Guard in `onTextEvent` handler

**File:** `frontend/src/features/documents/hooks/useDocumentCollab.ts` — `onTextEvent` (line 231)
- The runtime guard above is sufficient; no additional hook-level guard needed

---

## Acceptance Criteria

1. A document with `yjs_state = NULL` and non-empty `content` gets its Y.Doc initialized server-side on first session acquire
2. Client no longer calls `bootstrapTextIfEmpty` (or it's a no-op fallback)
3. Opening the same document in two tabs simultaneously does NOT produce duplicate content
4. Existing documents with valid `yjs_state` continue to work normally
5. `make test` passes in backend
6. `pnpm run test` passes in frontend
7. `pnpm run lint` passes in frontend

## Testing Approach

- Unit test: Backend `loadState` initializes Y.Doc from `content` when `yjs_state` is NULL
- Unit test: Backend `loadState` does NOT re-initialize when `yjs_state` is already populated
- Regression: Existing collab sync tests still pass
