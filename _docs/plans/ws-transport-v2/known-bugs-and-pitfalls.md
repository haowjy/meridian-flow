---
detail: standard
audience: developer
---
# Known Bugs and Real-World Pitfalls

## Bugs Fixed By This Refactor

### Bug #10: Multi-Doc Sync Responses Misrouted (CRITICAL)

**Symptom:** After subscribing to 3 documents on one WS, a follow-up sync-step1 for doc A returns a response tagged with doc B or C's UUID.

**Root cause:** Envelope-based document routing in the multiplexed project WS has subtle ordering issues when multiple documents sync concurrently.

**How v2 fixes it:** Per-document WS eliminates multiplexing entirely. Each connection carries exactly one document. Misrouting is structurally impossible.

**Smoke probe:** `tests/smoke/collab/multi-doc/` -- will be replaced with rapid-connect/disconnect stress test.

### Bug #9: Oversized Frame Kills Connection (HIGH)

**Symptom:** Sending a 1MB binary frame causes immediate EOF -- connection torn down, all document sessions lost.

**Root cause:** `conn.MaxPayloadBytes = 64KB`. Library (`golang.org/x/net/websocket`) closes the connection on exceed with no application-level hook.

**How v2 fixes it:** Raise library limit to 2MB (safety net). Add application-level check at 256KB -- returns `{"type":"error","code":"FRAME_TOO_LARGE"}` and continues the message loop. Connection stays alive.

**Smoke probe:** `tests/smoke/collab/envelope/` -- oversized test case updated to verify `FRAME_TOO_LARGE` error.

### Bug #11: No Origin Validation (MEDIUM)

**Symptom:** `Origin: https://evil.example.com` accepted during WS upgrade.

**Root cause:** WS upgrader's `CheckOrigin` / `Handshake` returns true unconditionally.

**How v2 fixes it:** Both document and project WS upgraders validate Origin against `config.CORSOrigins`. Dev mode allows all; prod rejects mismatches with HTTP 403.

**Smoke probe:** `tests/smoke/collab/security/` -- cswsh-origin test.

---

## Bugs to Fix During Refactor

These are pre-existing bugs from the audit (`tests/.scratchpad/bugs-found.md`) that should be addressed while touching the affected code:

| Bug | File | Issue | Fix |
|-----|------|-------|-----|
| #6 | `collab_snapshot.go:301` | Snapshot restore clears `ai_content` | Pass `restoredContent` for both `content` and `ai_content` in `SaveState()` |
| #7 | `collab_snapshot.go:283` | Pre-restore safety snapshot captures empty state for REST-only docs | Bootstrap before saving safety snapshot |
| #8 | `collab_snapshot_test.go` | No `CreateSnapshot` handler tests | Add tests for bootstrap path |

---

## Real-World Yjs Pitfalls to Watch For

From production reports across y-websocket, Hocuspocus, and Liveblocks. These are failure modes that affect ANY Yjs system, not just Meridian.

### Reconnect Duplication

**What happens:** Client reconnects, server sends full state, client applies it on top of existing state. If the client didn't properly reset, content appears duplicated.

**Reported:** Hocuspocus [issue #344](https://github.com/ueberdosis/hocuspocus/issues/344)

**Meridian guard:** On reconnect, the Yjs sync protocol handles state reconciliation automatically via state vectors. But if a Y.Doc is reused across connections without proper cleanup, duplicates can occur. The `CollabSyncRuntime.destroy()` + recreate pattern must be preserved.

### Sync Event Fires Before State Available

**What happens:** `'sync'` event fires but the document is actually empty -- subsequent reads return blank content.

**Reported:** y-websocket [issue #81](https://github.com/yjs/y-websocket/issues/81)

**Meridian guard:** `onInitialSyncComplete` fires after SyncStep2 is applied, not after SyncStep1. The two-phase IDB lifecycle (load cache -> server sync -> recreate IDB) adds a second safety layer.

### Duplicate Yjs Library Imports

**What happens:** Two copies of `yjs` in the bundle (e.g., different versions via transitive deps). Internal constructor checks fail silently, causing sync corruption.

**Reported:** Yjs [issue #438](https://github.com/yjs/yjs/issues/438), Liveblocks [best practices](https://liveblocks.io/docs/guides/yjs-best-practices-and-tips)

**Meridian guard:** Single `yjs` version pinned in `pnpm-lock.yaml`. The `cm6-collab` package uses the same instance. Verify with `pnpm why yjs` -- should show exactly one version.

### Intermediate-State Surprises

**What happens:** Misordered updates temporarily hide Y.Map keys even though the document eventually converges.

**Reported:** Yjs [issue #591](https://github.com/yjs/yjs/issues/591)

**Meridian relevance:** Low for text editing (Y.Text is append-optimized). Higher risk if metadata is stored in Y.Map structures. Document-scoped metadata should use the DB, not the CRDT.

### Document Accumulation / Unload Leaks

**What happens:** Server accumulates loaded documents in memory without proper unloading. GC never fires because references are held.

**Reported:** Hocuspocus [issue #846](https://github.com/ueberdosis/hocuspocus/issues/846)

**Meridian guard:** `session_manager.Release(docID)` with reference counting. When last connection closes, session persists state and unloads after idle timeout. Verify: no session leaks after rapid connect/disconnect cycles.

---

## Pitfalls Specific to the v2 Migration

### Keep-Alive Pool Leaks

**Risk:** Warm connections not properly cleaned up on project switch or tab close.

**Guard:** Connection manager must hook into:
- `beforeunload` event (tab close)
- Project navigation (close all document connections for old project)
- Warm pool eviction timer must use `clearTimeout` on cleanup

### Anticipatory Connection Race

**Risk:** LLM edits doc, `doc:edited` triggers warmup, but the document is deleted before user navigates to it.

**Guard:** Document WS auth validates document exists and user has access. If deleted, auth fails gracefully and connection manager removes from warm pool.

### Proposal Event Ordering

**Risk:** Proposal events on project WS arrive before document WS is connected. Client sees "new proposal" notification but can't render the diff because no Y.Doc exists yet.

**Guard:** Proposal manager should buffer events for documents without an active runtime. When document WS connects and syncs, replay buffered proposal events. The existing `proposal:snapshot` on project connect already handles the initial state -- incremental events during the gap are the concern.

### State Freshness Between HTTP and WS

**Risk:** HTTP bootstrap endpoint returns state from DB. Between HTTP fetch and WS SyncStep1, the in-memory session may have newer state. Client could apply stale HTTP state.

**Guard:** After HTTP bootstrap, client sends SyncStep1 which includes the HTTP state's state vector. Server's SyncStep2 will contain any updates since the HTTP snapshot. Yjs merge is idempotent -- applying slightly stale state followed by a diff is correct.
