# Bugs Found During Smoke Test Development

## 1. Project PATCH validation: `*string` type assertion failure

**File:** `backend/internal/service/docsystem/project.go:232`
**Symptom:** `PATCH /api/projects/{id}` with `{"name":"..."}` returns 400: "name must be a string"
**Root cause:** `validateProjectName()` does `value.(string)` but the value is `*string` (pointer). `validation.Validate(req.Name, ...)` passes a `*string` since `req.Name` is `*string`, and ozzo-validation's `validation.By()` passes the raw value to the custom func.
**Fix:** Dereference before passing to validation: `validation.Validate(*req.Name, ...)` — safe because we already checked `req.Name != nil`.
**Classification:** Real backend bug. Tests correctly identified it.

## 2. Snapshot creation captures empty Yjs state for REST-only docs

**File:** `backend/internal/handler/collab_snapshot.go:113-121`
**Symptom:** Snapshots of documents created via REST (never WS-connected) have empty content.
**Root cause:** `yjs_state` is NULL after REST document creation. Snapshot creation reads `yjs_state` directly via `LoadState()`, which returns empty bytes for NULL. The snapshot is then saved with empty Yjs state.
**Fix:** Added `bootstrapYjsState()` to snapshot handler — if `yjs_state` is empty at snapshot creation time, bootstrap a Y.Doc from the `content` column and persist it before snapshotting. Same pattern as `session_manager.loadState()` and `ai_content_projector.bootstrapFromContent()`.
**Classification:** Real backend bug. The Yjs-to-REST lifecycle gap was the root cause, not the test.

## 3. Snapshot restore sets content column to empty

**File:** `backend/internal/handler/collab_snapshot.go:282`
**Symptom:** After `POST /api/documents/{id}/snapshots/{sid}/restore`, GET returns `{"content":""}` instead of the snapshot's text content.
**Root cause:** `SaveState(ctx, docID, target.YjsState, "", "")` intentionally set content to empty with a TODO comment. The `decodeSnapshotContent()` helper already existed but wasn't used here.
**Fix:** Extract content from Yjs state before saving: `decodeSnapshotContent(target.YjsState)` and pass to `SaveState`.
**Classification:** Real backend bug. Tests correctly identified it.

## 4. `run.sh` arithmetic causes exit under `set -e`

**File:** `tests/smoke/run.sh:36`
**Symptom:** Full test suite exits after first passing probe with exit code 1.
**Root cause:** `((passed++))` when `passed=0` evaluates `((0))` which is falsy -> exit code 1 -> `set -e` aborts the script.
**Fix:** Use `passed=$((passed + 1))` instead of `((passed++))`.
**Classification:** Test infrastructure bug.

## 5. Handshake probe missing FORBIDDEN expect value

**File:** `tests/smoke/collab/handshake/probe.go:112-129`
**Symptom:** Probe failed with "unsupported --expect value FORBIDDEN".
**Root cause:** The probe only supported AUTH_FAILED, DOCUMENT_NOT_FOUND, and SYNC_OK. Server returns FORBIDDEN for non-existent docs (intentional security pattern — see `collab_authenticator.go:107-154`).
**Fix:** Added `FORBIDDEN` case to the probe, and generalized `expectDocumentNotFound` into `expectDocError` that takes expected code as parameter.
**Classification:** Test gap (probe didn't cover the actual server behavior). Server behavior is correct and intentional.

## 6. Snapshot restore clears `ai_content` column

**File:** `backend/internal/handler/collab_snapshot.go:301`
**Symptom:** After snapshot restore, AI content reads return blank.
**Root cause:** `SaveState(ctx, docID, target.YjsState, restoredContent, "")` passes empty string for `ai_content`. Because `LoadAIContent()` uses `COALESCE(ai_content, content, '')`, an empty string wins over the `content` fallback — so AI/editor reads go blank.
**Fix:** Pass `restoredContent` for both `content` and `ai_content`: `SaveState(ctx, docID, target.YjsState, restoredContent, restoredContent)`. Same pattern as the offline apply fix (harden-collab Task 1).
**Classification:** Real backend bug. Same class as the `aiContent` clobber that was already fixed in `session_manager.go:190`. Found by gpt-5.4 audit.
**Status:** Not yet fixed.

## 7. Pre-restore safety snapshot captures empty state

**File:** `backend/internal/handler/collab_snapshot.go:283`
**Symptom:** Safety snapshot before restore is useless if document was REST-only (never WS-connected).
**Root cause:** `LoadState()` returns empty bytes for NULL `yjs_state`. The safety snapshot is saved with that empty state. If you need to revert the restore, the safety snapshot has no content.
**Fix:** Apply the same bootstrap-if-empty pattern before saving the safety snapshot, or skip the safety snapshot when state is empty (since there's nothing meaningful to preserve).
**Classification:** Edge case bug. Low severity — safety snapshots are a fallback mechanism.
**Status:** Not yet fixed.

## 8. Missing test coverage for snapshot create + bootstrap

**File:** `backend/internal/handler/collab_snapshot_test.go`
**Symptom:** No `CreateSnapshot` handler tests exist. The bootstrap logic added in Bug #2 fix has no unit test coverage.
**Root cause:** Test file only covers restore and content retrieval paths.
**Fix:** Add tests for: (1) CreateSnapshot with non-empty yjs_state (happy path), (2) CreateSnapshot with empty yjs_state triggering bootstrap, (3) restore checking ai_content is set correctly.
**Classification:** Test gap. Found by gpt-5.4 audit.
**Status:** Not yet fixed.

## 9. Oversized WebSocket frame kills connection (no graceful rejection)

**File:** Backend WebSocket handler (likely gorilla/websocket read-limit or similar)
**Symptom:** Sending a 1MB binary frame over the collab WebSocket causes an immediate EOF — connection is torn down rather than returning an error and keeping the socket alive.
**Root cause:** The server likely has a max message size limit (e.g., `ReadLimit` on the websocket upgrader) but when a frame exceeds it, the library closes the connection entirely instead of the server sending back a `doc:error` or similar structured rejection.
**Expected behavior:** Like the other malformed frames (truncated, corrupted-yjs, wrong-doc-uuid, unknown-type, zero-payload), oversized frames should be rejected gracefully while keeping the WebSocket alive.
**Found by:** `collab/envelope` smoke probe — oversized test case.
**Status:** Not yet fixed.

## 10. Multi-doc sync responses misrouted to wrong document

**File:** Backend collab session manager / WebSocket message routing
**Symptom:** After subscribing to 3 documents (A, B, C) on one WebSocket, sending a follow-up sync-step1 for doc A returns a response tagged with doc B or C's UUID.
**Root cause:** The server's document-scoped sync response routing doesn't properly isolate responses per document when multiple subscriptions exist on a single WebSocket connection. A sync response may be tagged with a different document's UUID than the one that triggered it.
**Expected behavior:** Sync responses should always carry the document UUID they correspond to. A sync-step1 for doc A must only produce responses with doc A's UUID.
**Found by:** `collab/multi-doc` smoke probe — multi-subscribe follow-up sync test.
**Status:** Not yet fixed.

## 11. WebSocket Origin header not validated (CSWSH risk)

**File:** Backend WebSocket upgrader configuration
**Symptom:** `Origin: https://evil.example.com` is accepted during WebSocket upgrade with no rejection.
**Root cause:** The WebSocket upgrader's `CheckOrigin` function likely returns `true` unconditionally (or is not set), allowing any origin to establish a collab WebSocket connection.
**Expected behavior:** In production, only allowed origins should be accepted. In dev, this may be intentionally permissive.
**Found by:** `collab/security` smoke probe — cswsh-origin test (logged as WARN, not FAIL).
**Status:** Not yet fixed. Low priority in dev, but should be hardened before production.
