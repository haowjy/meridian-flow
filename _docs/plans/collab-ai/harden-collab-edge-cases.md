# Plan: Harden Collab Edge Cases + Clean Up Technical Debt

**Branch:** `h/collab`
**Status:** In Progress (audited 2026-02-27)
**Created:** 2026-02-22
**Last Audited:** 2026-02-27

## Problem

A multi-agent audit of the WebSocket/Yjs collab system identified correctness bugs, dead code, interface bloat, and missing safety checks across both stacks. Findings are grouped into two phases: **correctness fixes** (data loss, error handling) and **cleanup** (dead code, ISP violations, missing checks).

### Correctness Issues

1. **`aiContent` clobber** — `applyUpdateOffline` passes `""` for `aiContent`, wiping the AI content projection on every offline proposal apply (`session_manager.go:192`).
2. **Subscribe error mapping** — `NotFoundError` from the store propagates as generic `INTERNAL_ERROR` to the client (`collab_project.go:202`).
3. **Missing `rows.Err()` checks** — Row iteration in `document_store.go:161-170` and `document_touch_store.go:63-71,90-98` silently ignores scan/stream errors.

### Technical Debt

4. **Dead backend code** — `ErrNoActiveSession` declared but never returned; `DocumentTouchStore` has interface + implementation with zero call sites; unused `logger` fields in 5 repository structs.
5. **Dead frontend code** — `editOpsToMergeChanges()`, `deriveProposalReviews()` (plural), `deriveProposalReview()` + `normalizeForDiff()`, orphaned MergeView legacy API — all exported, never imported.
6. **Fat `DocumentStore` interface** — Mixes state persistence, snapshots, and cleanup in one contract. Test fakes across 4 packages must implement 7+ no-op stubs. Same ISP pattern we already fixed for `DocumentContentLoader`.
7. **Frontend reconnect coupling** — `didStartSync` is one-shot per runtime; reconnect relies implicitly on server-initiated SyncStep1. No test coverage, no documentation of the coupling.

### Considered and Dropped

- **Singleflight `Acquire`** — The current double-check lock is correct; the second caller just does redundant DB work. Singleflight + refCount interaction is a bug magnet. Not worth it for single-instance deployment.
- **CAS bootstrap write** — Only matters for horizontal scaling which doesn't exist. Adds interface surface and test complexity for a theoretical race.
- **Per-doc offline apply mutex** — The race (two auto-accepted proposals for the same doc at the same instant when no editor is open) is extremely unlikely, and Yjs CRDT handles re-application. `sync.Map` adds leak surface.
- **`AIContentProjector` folding into `ProposalService`** — Valid observation but large blast radius. Better as a separate refactor.
- **`proposalAcceptGate` dual-mutex consolidation** — Works correctly; simplification is low-value.

## Tasks

Seven lean tasks. Each ends in a working commit.

---

## Task 1: Fix `aiContent` Clobber in `applyUpdateOffline`

**Goal:** Stop wiping `ai_content` column on every offline proposal apply.

**File:** `backend/internal/service/collab/session_manager.go:192`

Change:
```go
// BEFORE (bug — clobbers ai_content)
if err := m.store.SaveState(ctx, docID, newState, content, ""); err != nil {

// AFTER
// aiContent mirrors content — the AIContentProjector will recompute as needed.
if err := m.store.SaveState(ctx, docID, newState, content, content); err != nil {
```

**Test:** Add test in `session_manager_test.go` — call `ApplyUpdate` with no active session (offline path), assert `savedAIContent` matches `savedContent` (not empty string).

---

## Task 2: Subscribe Error Mapping for NotFound

**Goal:** Surface `DOCUMENT_NOT_FOUND` instead of generic `INTERNAL_ERROR` when a document is deleted during subscribe.

### Backend

**File:** `backend/internal/handler/collab_project.go` — In `handleDocSubscribe` error handling (after line 191):

```go
if errors.Is(err, domain.ErrNotFound) {
    h.sendDocError(conn, canonicalDocumentID, "DOCUMENT_NOT_FOUND",
        "document no longer exists")
    return
}
```

Add `"meridian/internal/domain"` import if not present.

### Frontend

**File:** `frontend/src/features/documents/hooks/useProjectCollab.ts` — In `doc:error` handler:

```typescript
if (docError.code === "DOCUMENT_NOT_FOUND") {
    log.warn("document not found during subscribe", { documentId: docError.documentId });
    activeSubscriptions.delete(docError.documentId);
    return; // Don't retry — document is gone
}
```

**Test:** Backend handler test — set `testCollabStore.loadErr = domain.NewNotFoundError(...)`, subscribe, assert `DOCUMENT_NOT_FOUND` code in WS response.

---

## Task 3: Add Missing `rows.Err()` Checks

**Goal:** Stop silently ignoring row iteration errors in repository layer.

**Files:**
- `backend/internal/repository/postgres/collab/document_store.go:161-170` (`ListSnapshots`)
- `backend/internal/repository/postgres/collab/document_touch_store.go:63-71` (`ListByDocument`)
- `backend/internal/repository/postgres/collab/document_touch_store.go:90-98` (`ListByTurn`)

After each `for rows.Next()` loop, add:
```go
if err := rows.Err(); err != nil {
    return nil, 0, fmt.Errorf("<operation>: row iteration: %w", err)
}
```

**No new tests needed** — this is a correctness guard; existing tests exercise the happy path. The bug only manifests on partial network/connection failures during result streaming.

---

## Task 4: Remove Dead Backend Code

**Goal:** Clean up unused symbols and implementations.

### 4a. Remove `ErrNoActiveSession`

**File:** `backend/internal/service/collab/session_manager.go:16-19`

This error is declared and documented but never returned — the code path now does offline apply instead. Delete the var declaration and its doc comment.

### 4b. Remove or park `DocumentTouchStore`

**Files:**
- `backend/internal/domain/services/collab/collab.go:51-56` — interface definition
- `backend/internal/repository/postgres/collab/document_touch_store.go` — entire file
- `backend/cmd/server/main.go` — remove wiring/constructor call

Zero call sites in production code. If we want to keep the schema for future use, just remove the Go code. The migration/table can stay.

### 4c. Remove unused `logger` fields from repositories

**Files:**
- `backend/internal/repository/postgres/collab/document_store.go:19` — `logger` field
- `backend/internal/repository/postgres/collab/proposal_store.go:23`
- `backend/internal/repository/postgres/collab/auto_accept_store.go:22`
- `backend/internal/repository/postgres/collab/document_touch_store.go:19` (if not deleted in 4b)
- `backend/internal/repository/postgres/collab/idempotency_store.go:22`

Remove the `logger` field from each struct. Update `NewXxxStore` constructors to stop accepting/setting it. Update callers in `main.go` if needed.

**Note:** Only remove if truly unused. `grep -n 's.logger' <file>` for each to confirm.

---

## Task 5: Remove Dead Frontend Code

**Goal:** Clean up exported-but-never-imported symbols from earlier design iterations.

### 5a. Remove `editOpsToMergeChanges`

**File:** `frontend/src/core/cm6-collab/review/ops-to-changes.ts:19` — function exported but never imported anywhere. Remove the function. Remove from `review/index.ts` export if present. Remove associated test cases if they only test this function.

### 5b. Remove `deriveProposalReviews` (plural batch method)

**File:** `frontend/src/core/cm6-collab/review/runtime.ts:159-166` — never called; replaced by per-proposal derivation. Remove method.

### 5c. Remove `deriveProposalReview` + `normalizeForDiff`

**File:** `frontend/src/core/cm6-collab/review/runtime.ts:47-94` (`deriveProposalReview`) and `:232-245` (`normalizeForDiff`) — dead code chain. Only used by the batch method removed in 5b. Remove both.

### 5d. Remove orphaned MergeView legacy API

**File:** `frontend/src/core/cm6-collab/review/merge.ts` — `mountProposalReviewMergeView`, `ProposalReviewMergeViewParams`, `ProposalReviewMergeViewHandle`. Comment references `SnapshotPreviewDiff` which doesn't exist. Remove file and its export from `review/index.ts`.

**Verify** with `grep -rn` that no imports reference these before deleting.

---

## Task 6: Split `DocumentStore` Interface (ISP)

**Goal:** Break the fat `DocumentStore` into focused consumer-side interfaces, reducing test stub noise.

### Backend Changes

**File:** `backend/internal/domain/services/collab/collab.go`

Split into:
```go
// DocumentStateStore persists and loads Yjs binary state + derived text projections.
type DocumentStateStore interface {
    LoadState(ctx context.Context, docID string) ([]byte, error)
    SaveState(ctx context.Context, docID string, state []byte, content string, aiContent string) error
}

// SnapshotStore manages document snapshots for history/restore.
type SnapshotStore interface {
    SaveSnapshot(ctx context.Context, docID string, state []byte, snapshotType string, name *string, createdByUserID *string) (string, error)
    ListSnapshots(ctx context.Context, docID string, limit, offset int) ([]collabModels.Snapshot, int, error)
    GetSnapshot(ctx context.Context, snapshotID string) (*collabModels.SnapshotWithState, error)
    DeleteSnapshot(ctx context.Context, snapshotID string) error
    DeleteExpiredAutoSnapshots(ctx context.Context, ttlHours int) (int64, error)
}
```

`PostgresDocumentStore` already implements both — Go structural typing means no code change needed on the implementation.

**Consumers update:**
- `DocumentSessionManager` depends on `DocumentStateStore` + `SnapshotStore` (needs both for persist + snapshot)
- `SubscriptionService` depends only on `SessionLifecycle` (no change)
- Handler snapshot endpoints depend on `SnapshotStore`
- Test fakes shrink: session tests only implement `DocumentStateStore` + `SnapshotStore` methods they use

**Remove the original `DocumentStore` interface** after all consumers are migrated.

Update `main.go` wiring — pass `collabStore` (concrete `*PostgresDocumentStore`) to each consumer. Go implicit satisfaction handles the rest.

---

## Task 7: Frontend Reconnect Sync Test + Coupling Comment

**Goal:** Document the server-initiated SyncStep1 coupling and add test coverage.

### Comment

**File:** `frontend/src/core/cm6-collab/sync/runtime.ts` — above `didStartSync`:

```typescript
// Defense-in-depth: prevents duplicate doc:subscribed events from
// re-sending SyncStep1 within the same runtime lifecycle.
//
// COUPLING NOTE: On WebSocket reconnect, the runtime instance is reused
// (didStartSync remains true). Re-sync works because the server sends
// SyncStep1 as part of every doc:subscribe handler (collab_project.go).
// If server behavior changes, this guard must be revisited.
private didStartSync = false;
```

### Test

**File:** `frontend/tests/cm6-collab/runtime-reconnect-sync.test.ts` (new)

1. Create runtime, call `startSync()` — verify SyncStep1 sent.
2. Simulate server sending SyncStep1 (as happens on re-subscribe after reconnect).
3. Verify runtime responds with SyncStep2 (via `handleBinaryFrame`).
4. Proves re-sync works with `didStartSync=true` on reused runtime.

---

## Out of Scope (Tracked Separately)

- **Stale `content` column reconciliation** — architectural question, not a bug
- **Session leak on handler crash** — needs TTL/heartbeat mechanism
- **Debounce persist retry** — fire-and-forget is acceptable for now; dirty flag preserves data until next flush
- **`ProposalService` file splitting** — valid god-file concern but large blast radius
- **Duplicate broadcast logic consolidation** — drift risk but low severity
- **Horizontal scaling** — separate initiative

## Verification Notes (Audit: 2026-02-27)

- Code evidence reviewed:
  - `ai_content` offline clobber fix + test: `backend/internal/service/collab/session_manager.go`, `backend/internal/service/collab/session_manager_test.go` (latest related commit: 2026-02-22).
  - Subscribe not-found mapping + frontend handling + tests: `backend/internal/handler/collab_project.go`, `backend/internal/handler/collab_project_test.go`, `frontend/src/features/documents/hooks/useProjectCollab.ts`, `frontend/tests/projectCollab.test.ts` (latest related commit: 2026-02-23).
  - Repository iteration guard/debt cleanup: `backend/internal/repository/postgres/collab/document_store.go`; `backend/internal/repository/postgres/collab/document_touch_store.go` removed; no `ErrNoActiveSession` symbol found; logger fields removed from collab stores (commits dated 2026-02-22).
  - Frontend dead review API cleanup: `frontend/src/core/cm6-collab/review/runtime.ts`, `frontend/src/core/cm6-collab/review/index.ts`; `frontend/src/core/cm6-collab/review/merge.ts` removed (commit dated 2026-02-22).
  - Interface split + reconnect coupling doc/test: `backend/internal/domain/services/collab/collab.go`, `frontend/src/core/cm6-collab/sync/runtime.ts`, `frontend/tests/cm6-collab/runtime-reconnect-sync.test.ts` (commits dated 2026-02-22 to 2026-02-23).
- Targeted verification run on 2026-02-27:
  - `go test ./backend/internal/service/collab ./backend/internal/handler` -> pass.
  - `cd frontend && pnpm vitest run tests/projectCollab.test.ts tests/cm6-collab/runtime-reconnect-sync.test.ts tests/useDocumentCollabTransport.test.ts` -> pass (3 files, 17 tests).

## Verification run (2026-02-27)

- Reconnect/resubscribe: `cd frontend && pnpm vitest run --reporter=verbose tests/projectCollab.test.ts -t 'replays active document subscriptions after reconnect|drops active subscription after DOCUMENT_NOT_FOUND doc:error'` -> PASS (`replays active document subscriptions after reconnect`).
- Offline proposal apply + `ai_content` projection: `cd backend && go test -v ./internal/service/collab -run 'TestDocumentSessionManagerApplyUpdate_OfflinePersistsAIContentWithContent' -count=1` -> PASS.
- Snapshot preview/restore: `cd backend && go test -v ./internal/handler -run 'TestGetSnapshotContent_Success|TestRestoreSnapshot_Success' -count=1` -> PASS.
- Deleted-doc subscribe error path (`DOCUMENT_NOT_FOUND`): `cd backend && go test -v ./internal/handler -run 'TestProjectWS_DocSubscribeDocumentNotFound' -count=1` and frontend command above -> PASS.

## Acceptance Criteria

- [ ] `go test ./backend/...` passes (full suite not run in this audit)
- [ ] `cd frontend && pnpm run test` passes (full suite not run in this audit)
- [ ] `cd frontend && pnpm run lint` passes (not run in this audit)
- [x] `aiContent` is no longer clobbered to empty on offline apply
- [x] `DOCUMENT_NOT_FOUND` error code surfaces to frontend on deleted-doc subscribe
- [x] `rows.Err()` checked after all row iterations in collab repos
- [x] Dead backend code removed (`ErrNoActiveSession`, `DocumentTouchStore`, unused logger fields)
- [x] Dead frontend code removed (4 orphaned exports/files)
- [x] `DocumentStore` split into `DocumentStateStore` + `SnapshotStore`; test fakes simplified
- [x] Reconnect re-sync test proves server-initiated SyncStep1 works with reused runtime
- [x] Targeted regression tests listed in verification notes pass (2026-02-27)
