# v1 Launch Backlog

## Critical (fix before launch)

| Issue | Location | Fix | Status |
|-------|----------|-----|--------|
| Spawn `waitForCompletion` uses `AuthorizeTurnStream` with `userID=""` | `streaming/spawn_service.go:409-442` | Expose real executor completion signal or poll persisted turn state, not auth API | ✅ |
| Spawn limit race — count+insert not in same transaction | `streaming/spawn_service.go:66-118` | Move count+insert into one transaction with locking or DB-level cap enforcement | ✅ |
| `remaining_input` always 0 for kimi-k2.5 | `context_budget.go` + model capabilities | `max_output` set to full `context_window` (262144) — fix model capability data | ✅ |

## High Priority — Architecture

| Item | Design Doc | What to Build | Status |
|------|-----------|--------------|--------|
| Multiplex agent SSE streams | `_docs/future/refactoring-backlog.md` (SSE connection starvation) | Single project-level SSE/WS for all agent events. Per-turn SSE shares browser's HTTP/1.1 6-connection limit — 3 agent streams starve API calls. Multiplex with channel-based subscribe/unsubscribe. | ⬜ |

## Required Features

| Item | Design Doc | What to Build | Status |
|------|-----------|--------------|--------|
| Background execution | `features/agents/background-execution.md` | `background_tasks` table, detached goroutine manager, `check_background` tool, server restart recovery | ⬜ |
| Thread notifications | `features/agents/thread-notifications.md` | `internal` turn role, ThreadNotifier, WebSocket `thread_activity` events, auto-wake | ⬜ |
| Arbitrary tool registration | — | Open tool registry (MCP-style). Built-in and external tools register the same way. Persona allow/deny works uniformly. | ⬜ |
| Skill CRUD migration (Phase A) | `refactoring-design.md` (Skill Migration section) | File-backed ProjectSkillService, removed `enabled` from API. Phase B (remove DB tables) deferred to Phase 4. | ✅ |
| Skill/agent management UI | — | Dedicated editor panel for skills and agents. Form for frontmatter fields + markdown body. Key concern: audit trail (git-backed change history, diff view, who changed what). Agent-authored changes should go through review gate (proposal pattern). Hidden from doc tree, accessible via dedicated UI. | ⬜ |

## Editor Refactor (Phases 2–7)

Phase 1 (Yjs-first Editor) is complete — uncontrolled `Editor`, shared `createEditorExtensions()`, Storybook migrated. Phases 2–3 complete, Phase 4 partially complete. Each has a blueprint in `plan/editor/`.

| Phase | Blueprint | What to Build | Status |
|-------|-----------|--------------|--------|
| 2 | `plan/editor/phase-2-doc-session-and-session-pool.md` | `DocSession` lifecycle (Y.Doc + IDB + awareness + undo), `SessionPool` with LRU eviction, Dexie schema, generation guards for idle timers, IDB health tracking + degraded mode | ✅ |
| 3 | `plan/editor/phase-3-view-controller-and-use-document-sessions.md` | Per-surface `ViewController` with lease transfer + view-owner registry, `useDocumentSessions()` hook replacing `useTabManager`, epoch-based async serialization, `useFollowActiveDoc` for mirrored surfaces, awareness lifecycle (`clearCursorAwareness`/`refreshCursorAwareness`), old TabManager deleted | ✅ |
| 4 | `plan/editor/phase-4-websocket-provider.md` | Real WS provider matching backend protocol (`y-protocols/sync` handshake), reconnect, `AUTH_EXPIRED` token refresh, `document:restored` full-reset path | 🔶 P4.1 done |
| 5 | `plan/editor/phase-5-proposal-persistence-and-offline-review.md` | Dexie-backed AI proposal runtime, diff derivation via Yjs projection clone+apply+diff, offline accept/reject, proposal GC | ⬜ |
| 6 | `plan/editor/phase-6-sync-state-and-connection-ui.md` | Per-doc sync state machine, connection indicators ("Saved"/"Connected"/"Offline"), degraded-local-save banner | ⬜ |
| 7 | `plan/editor/phase-7-decoration-audit.md` | ViewPlugin performance audit: viewport scoping, rebuild guards, widget `eq()`+`updateDOM()`, stress stories | ⬜ |

**Phase 4 detail:** P4.1 (DocumentWsProvider with y-protocols/sync, heartbeat, reconnect backoff, auth expiry, control events) is complete. P4.2 (wire provider events into DocSession — syncState/connectionState/frozenReason updates) and P4.3 (connection lifecycle stories) remain.

**Dependency chain:** P2 → P3 + P4 (parallel) → P5 + P6 (parallel) → P7. See `plan/editor-refactor-implementation.md` for execution rounds and agent team.

## Deferred from Phase 3 Review

| Item | Severity | What | Deferred to |
|------|----------|------|-------------|
| DocSession WS event wiring | HIGH | Provider emits `onConnectionState`/`onControlEvent` but DocSession never subscribes — syncState/connectionState/frozenReason don't update from real provider state | P4.2 (explicit scope) |
| `getSession()` returns mutable DocSession | MEDIUM | Hook escape hatch leaks full mutable object; proposal pipeline should use narrower read-only interface | Phase 5 |
| Word count integration | MEDIUM | Extension mounted in EditorView but getter discarded — shell can't display live word count from session-managed views | Layout integration |
| Metadata ownership drift | LOW | `name`/`isModified` on ViewController (surface-scoped) but conceptually document-scoped. Two surfaces can diverge on same doc's name. | Document metadata layer |

## Open Decisions

| Decision | Context | Impact | Status |
|----------|---------|--------|--------|
| Converse/Studio tab independence | Resolved: build independent controllers (general case). Mirrored mode is a layout-level `useFollowActiveDoc` hook — no controller/hook changes needed. Both modes work from the same architecture. See design doc "Surface Coordination Modes" section. | No longer blocks Phase 3. | ✅ |
| Backend text projection for AI context | Backend projects Y.Doc → text on-demand from in-memory state. For FTS across documents, AI context in non-collab flows, and API responses, a persistent `content_text` column alongside Yjs binary state may be needed. | Additive. Not blocking editor refactor. | ⬜ |

## Manual Verification (after Phase 3 wires up ViewController)

Once ViewController connects SessionPool → Editor (Phase 3), a human should verify in a real browser:

| Check | What to do | Why |
|-------|-----------|-----|
| IDB persistence round-trip | Open doc, type, close tab, reopen → content persists | `fake-indexeddb` in tests doesn't cover real browser IDB quirks |
| IDB in private browsing | Open Storybook in private/incognito → degraded mode warning appears | y-indexeddb may fail silently in some browsers |
| Session warm/cold cycle | Open doc, switch to another, switch back → content rehydrates instantly from warm session | Generation guard + idle eviction timing in real usage |
| Multi-tab collab (Phase 4+) | Two browser tabs editing same doc → changes sync | WebSocket provider + Yjs merge |
| Quota stress | Fill IDB near quota → degraded mode triggers | Post-open write failures are silent (y-indexeddb limitation, tracked) |
| Safari IDB | Test all IDB paths on Safari — Safari has the most IDB bugs | Cross-browser compat |

## Doc Drift

| Stale Doc | What Changed | Fix |
|-----------|-------------|-----|
| `features/layouts/studio-chrome.md` | Still says Converse always mirrors Studio's active tab. Phase 3 landed with independent per-surface `activeDocId` + lease transfer + `useFollowActiveDoc` for optional mirroring. | Update to reflect Surface Coordination Modes from design doc. |
| `frontend-v2/CLAUDE.md` Phase 3 status | Says Phase 3 (Editor) is "not started" but editor refactor Phases 1–3 are complete. Full session management, ViewController, awareness lifecycle, and WS provider (P4.1) are implemented. Directory structure reorganized into `session/`, `transport/`, `components/`, `collab/`. | Update to reflect current state. |
