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

Phase 1 (Yjs-first Editor) is complete — uncontrolled `Editor`, shared `createEditorExtensions()`, Storybook migrated. Phases 2–7 remain. Each has a blueprint in `plan/editor/`.

| Phase | Blueprint | What to Build | Status |
|-------|-----------|--------------|--------|
| 2 | `plan/editor/phase-2-doc-session-and-session-pool.md` | `DocSession` lifecycle (Y.Doc + IDB + awareness + undo), `SessionPool` with LRU eviction, Dexie schema, generation guards for idle timers, IDB health tracking + degraded mode | ⬜ |
| 3 | `plan/editor/phase-3-view-controller-and-use-document-sessions.md` | Per-surface `ViewController` with lease transfer, `useDocumentSessions()` hook replacing `useTabManager`, awareness clear on view detach (ghost cursor fix) | ⬜ |
| 4 | `plan/editor/phase-4-websocket-provider.md` | Real WS provider matching backend protocol (`y-protocols/sync` handshake), reconnect, `AUTH_EXPIRED` token refresh, `document:restored` full-reset path | ⬜ |
| 5 | `plan/editor/phase-5-proposal-persistence-and-offline-review.md` | Dexie-backed AI proposal runtime, diff derivation via Yjs projection clone+apply+diff, offline accept/reject, proposal GC | ⬜ |
| 6 | `plan/editor/phase-6-sync-state-and-connection-ui.md` | Per-doc sync state machine, connection indicators ("Saved"/"Connected"/"Offline"), degraded-local-save banner | ⬜ |
| 7 | `plan/editor/phase-7-decoration-audit.md` | ViewPlugin performance audit: viewport scoping, rebuild guards, widget `eq()`+`updateDOM()`, stress stories | ⬜ |

**Dependency chain:** P2 → P3 + P4 (parallel) → P5 + P6 (parallel) → P7. See `plan/editor-refactor-implementation.md` for execution rounds and agent team.

## Open Decisions

| Decision | Context | Impact | Status |
|----------|---------|--------|--------|
| Converse/Studio tab independence | Design assumes independent `activeDocId` per surface with lease transfer. Product may want Converse to mirror Studio's active tab instead. | Blocks Phase 3 implementation — resolve before P3.1. | ⬜ |
| Backend text projection for AI context | Backend projects Y.Doc → text on-demand from in-memory state. For FTS across documents, AI context in non-collab flows, and API responses, a persistent `content_text` column alongside Yjs binary state may be needed. | Additive. Not blocking editor refactor. | ⬜ |

## Doc Drift

| Stale Doc | What Changed | Fix |
|-----------|-------------|-----|
| `features/layouts/studio-chrome.md` | Still says Converse always mirrors Studio's active tab. The editor refactor design supersedes this with independent per-surface `activeDocId` + lease transfer. | Update when Phase 3 lands, or earlier if the open decision above is resolved. |
| `frontend-v2/CLAUDE.md` Phase 3 status | Says Phase 3 (Editor) is "not started" but a full WIP editor exists in `frontend-v2/src/editor/` with collab, IDB, decorations. Phase 1 of the refactor is now complete. | Update to reflect current state. |
