# Yjs State Lifecycle Gaps

Analysis of how `yjs_state` and `content` columns interact, based on codebase exploration + gpt-5.4 research with Yjs ecosystem best practices (Hocuspocus, Y-Sweet, Liveblocks).

## Fixed (short-term)

### 1. Snapshot creation bootstraps Yjs state from content if empty

**Before:** `POST /api/documents/{id}/snapshots` captured NULL `yjs_state` for REST-only docs, creating empty snapshots.

**After:** If `yjs_state` is empty at snapshot creation, the handler bootstraps a Y.Doc from the `content` column, persists the bootstrapped state, then snapshots it. Same pattern as `session_manager.loadState()` and `ai_content_projector.bootstrapFromContent()`.

**Files changed:** `backend/internal/handler/collab_snapshot.go` — added `contentLoader` field and `bootstrapYjsState()` method.

### 2. Snapshot restore extracts content from Yjs state

**Before:** Restore set `content = ""` with a TODO comment.

**After:** Restore calls `decodeSnapshotContent()` to extract text from the snapshot's Yjs state before saving.

### 3. Project PATCH validation

**Before:** `*string` type assertion failed in `validateProjectName`.

**After:** Dereference before validation: `validation.Validate(*req.Name, ...)`.

## Known gaps (medium-term)

### REST PATCH doesn't update yjs_state

When `PATCH /api/documents/{id}` updates `content`, `yjs_state` is NOT updated.

**Impact:** If `yjs_state` already exists (from a prior WS session), the next WS connect uses the stale `yjs_state` and ignores the newer REST `content`. **This is silent data loss.**

**Current session_manager behavior** (lines 278-291):
```
if len(yjs_state) > 0:
    use yjs_state  ← stale after REST PATCH
else:
    bootstrap from content
```

**Recommended fix:** Route REST content PATCH through a Yjs-aware write path:
1. Load current `yjs_state` (or bootstrap if empty)
2. Apply content replacement through Yjs
3. Persist via `SaveState()` (which writes yjs_state + content + ai_content together)

See `backend/internal/repository/postgres/collab/document_store.go:100-124` — `SaveState()` already does the coordinated write.

### Document creation doesn't initialize yjs_state

Documents are born with `yjs_state = NULL`. Multiple server-side consumers then need to defensively bootstrap (session_manager, ai_content_projector, snapshot handler).

**Recommended fix (medium-term):** Bootstrap `yjs_state` eagerly at `POST /api/documents` time. This eliminates the "has this doc ever been connected via WS?" branching across the codebase.

### Snapshot restore clears ai_content

`SaveState(ctx, docID, target.YjsState, restoredContent, "")` passes empty string for `ai_content`. Same bug class as the offline apply clobber (already fixed in `session_manager.go:190`). `LoadAIContent()` uses `COALESCE(ai_content, content, '')` so empty string wins over content fallback.

**Recommended fix:** `SaveState(ctx, docID, target.YjsState, restoredContent, restoredContent)`.

### Pre-restore safety snapshot can be empty

If `yjs_state` is NULL (REST-only doc), the pre-restore safety snapshot captures empty state. The safety net is useless. Either bootstrap before snapshotting or skip when state is empty.

### FORBIDDEN for non-existent documents

The server returns `FORBIDDEN` (not `DOCUMENT_NOT_FOUND`) when subscribing to a non-existent document. This is **intentional information hiding** — see `collab_authenticator.go:107-154`, where `VerifyOwnership` maps `ErrNotFound` to `false` to prevent enumeration attacks. The smoke test correctly expects `FORBIDDEN`.

## Architecture target (long-term)

From gpt-5.4 research with Yjs ecosystem citations:

> "The standard pattern is one authoritative CRDT state plus optional derived/exported views. Parallel writable representations are a migration bridge, not a stable end state."

Target: `yjs_state` is the canonical editable representation. `content` and `ai_content` are derived projections. All mutation paths go through the CRDT.

See `.meridian/fs/yjs-state-lifecycle-analysis.md` for full analysis with citations.
