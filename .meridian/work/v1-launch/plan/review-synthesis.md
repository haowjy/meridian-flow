# Implementation Plan Review Synthesis

8 GPT-5.4 reviewers, each with a different focus area. All 8 returned "request changes."

## Spawn Reference

| Spawn | Focus | Severity |
|-------|-------|----------|
| p80 | Billing | 1 CRITICAL, 3 HIGH, 1 MEDIUM |
| p81 | Dependency graph + sequencing | 3 HIGH, 1 MEDIUM |
| p82 | Editor + CM6 + Collab | 1 CRITICAL, 3 HIGH, 1 MEDIUM |
| p83 | Agents platform | 2 CRITICAL, 2 HIGH, 1 MEDIUM |
| p84 | Layouts + UX + responsive | 4 HIGH |
| p85 | Data layer + threads + connectivity | 4 HIGH, 2 MEDIUM |
| p86 | Staffing + realism | 1 CRITICAL, 3 HIGH, 1 MEDIUM |
| p87 | Onboarding + auth + free tier | 4 HIGH, 2 MEDIUM |

## CRITICAL Findings (block implementation)

### 1. Billing reservation pattern not designed (p80, p86)
The implementation plan assumes reserve→execute→settle, but billing-design.md still documents check-then-act. No reservation entity, state machine, lot table, idempotency keys, or release/reaper. A coder cannot implement this autonomously — needs a design phase first.

**Action:** Design the reservation schema and state machine before Round 0 coding starts.

### 2. Undo model is self-contradictory (p82)
editor-direction.md says CM6 built-in undo, collab undo.md says Y.UndoManager over Y.Text + _proposal_status. These are fundamentally different systems. If both docs are followed, accepted hunks fall out of the typing undo timeline.

**Action:** Pick one source of truth (Y.UndoManager), update editor-direction.md to match.

### 3. A3 migration not rollback-safe (p83)
Plan says migrate project_skills → .agents/ files and drop the table in Round 0. Existing backend still reads from .meridian/skills/. Partial failure = no source of truth.

**Action:** Two-phase cutover: backfill files → dual-read → validate parity → drop table in a later round.

### 4. `.work/` vs `.meridian/work/` path inconsistency (p83)
work-items.md says `.work/<slug>/`, agent-tools.md says `.meridian/work/<work-item>/`, backend namespace service only knows workspace, .meridian, and .session. Write routing can't be implemented without a canonical path.

**Action:** Resolve to one canonical path. Update all design docs to match.

## HIGH Findings — Sequencing Issues

### 5. Layouts (F11) sequenced too late (p81, p84)
F11 waits for Editor + Explorer + Tabs + Threads. But shells are mode-aware composition over mode-agnostic panes. Split F11 into:
- **F11a (Round 1-2):** AppShell, rail, routing, panel infrastructure with mock panes
- **F11b (Round 3):** Wire real panes into shells

### 6. Round 2 isn't actually parallel (p81)
- Threads depends on @Mentions (F8 → F7)
- Explorer depends on Tabs (F5 ↔ F6 contract)
- Cap concurrent streams at 3-4, not 6

### 7. F14 Billing Frontend partially too late (p80, p87)
Threads need 402 handling and balance display in Round 2. Pull minimal balance widget + purchase CTA into Round 2 alongside Auth Frontend. Keep usage history in Round 3.

### 8. F12 Settings too late for .agents/ management (p83)
Migration happens in Round 0, but users can't inspect/repair until Round 3. Either delay destructive cutover or ship a minimal agents management UI earlier.

### 9. Onboarding stub needed earlier (p87)
The signup→credits→first-AI funnel is the integration harness. Deferring it all to Round 5 means activation friction discovered late. Ship an activation stub in Round 2-3.

## HIGH Findings — Missing Specifications

### 10. reconcile() for server rejection not specified (p85)
Optimistic flow has no spec for what happens when POST fails (402, validation error). Needs per-send state machine: pending → acked/rejected, ghost turn cleanup, composer restoration.

### 11. SSE resume checkpoint undefined (p85)
"Persist event cursor" and "Last-Event-ID" without defining the durable checkpoint tuple, per-thread vs per-turn scope, or partial-content reconstruction.

### 12. LRU eviction can race with active AI streaming (p85)
Tab evicts a doc session mid-AI-stream → transport switches WS→HTTPS without a lease/pin. "No dual-apply races" is aspirational without a session pin mechanism.

### 13. Decoration conflict matrix needed (p82)
Live preview and block rendering both use Decoration.replace. Collab hunks use marks/widgets. When a hunk lands inside hidden markdown syntax, there's no defined owner. Need an explicit conflict matrix, not just "layers stack."

### 14. F1 (CM6 Shared) scope wrong (p82)
Putting markdown decorations and mention insertion in shared Round 1 creates surface-specific flags. Narrow F1 to primitives (theme, keybindings). Pull mention entity contract forward but defer surface-specific rendering.

### 15. Prose analysis needs shared decoration scheduler (p82)
5th decoration producer with no shared invalidation/scheduling → will rescan large docs on every edit or drift vs other layers.

### 16. import-git needs security review (p83)
No URL allowlist, submodule policy, repo/file-size limits, or text/binary filtering. Not autonomous work.

### 17. Credit grant policy contradiction (p87)
Onboarding says "immediate credits." Billing says "verified email required." Need one policy.

### 18. Data layer needs public interface contract (p85)
C1 describes implementation pieces, not the stable API consumers bind to. Parallel features can't start without knowing the interface.

### 19. Mode-switch state preservation unspecified (p84)
"CSS/layout only" isn't believable without an explicit keep-alive/offscreen/hoisted-state design. Scroll and session state will be lost in naive implementation.

## HIGH Findings — Realism

### 20. Autonomy count overstated (p86)
Only ~3-4 workstreams truly autonomous (Writing Stats, parts of Auth). Agent tools, git import, just-bash, billing all need security/design review. Relabel honest autonomy levels.

### 21. Testing strategy too thin (p86)
Missing: integration tests for billing concurrency, contract tests for shared interfaces, E2E for signup→purchase→AI, reconnect/resume tests, load tests for billing.

### 22. 4-6 month estimate as written (p86)
Cut Writing Stats. Trim Import/Export (drop EPUB for v1). Make Prose Analysis a stretch goal. This compresses to ~3-4 months.

## MEDIUM Findings

### 23. IndexedDB quota has no pressure strategy (p85)
QuotaExceededError on pending-ops path silently breaks offline durability.

### 24. Connectivity backoff unspecified (p85)
No cap, jitter, reconnecting→offline threshold, or manual retry.

### 25. Responsive below-lg needs real fallback (p84)
"Desktop recommended" notice excludes split-screen laptops and tablet landscape. Need minimal single-pane fallback or justified min-width requirement.

### 26. Agents mode (rail) not cleanly scoped (p84)
F11 gives it a shell while F13 owns the dashboard content. Rail can expose a "mode" before its core surfaces exist.

### 27. Panel sizing lacks min/max constraints (p84)
200px fixed explorer + percentage panes + no clamp → too wide on ultrawide, too cramped on smaller desktops.

### 28. Dependency graph missing edges (p81)
Auth Frontend → Auth Backend, Command Palette → Settings, Onboarding → F14.

### 29. F13 Work Items UI underspecified (p83)
No concrete IA, state contract, or flows. Labeled "no existing patterns" but frontend already has adjacent patterns.

### 30. 300 credits not anchored to free-tier model set (p87)
Examples use premium models but free tier is standard-only. Define concrete first-session bundle.

### 31. Storybook review sessions understated (p86)
Realistically 10-14 sessions, not "2-3 rounds per component group."

### 32. MockCollab/MockStreaming protocol unspecified (p82)
Stories need a defined mock protocol using real backend event shapes + in-memory Y.Doc.

## Recommended Next Steps

### Before any coding starts:
1. **Design billing reservation** — schema, state machine, lot table, release/reaper (resolves #1)
2. **Resolve undo contract** — pick Y.UndoManager, update all docs (resolves #2)
3. **Resolve `.work/` path** — one canonical namespace, update all docs (resolves #4)
4. **Define C1 public interface** — what consumers bind to (resolves #18)
5. **Define credit grant policy** — OAuth = instant, email = post-verify (resolves #17)

### Sequencing fixes:
6. **Split F11** into F11a (shells with mocks, Round 1-2) + F11b (wire real panes, Round 3) (resolves #5)
7. **Split F14** — balance widget + 402 handling in Round 2, usage history in Round 3 (resolves #7)
8. **Two-phase A3 migration** — backfill + dual-read in Round 0, drop table in Round 2+ (resolves #3)
9. **Cap Round 2** at 3-4 parallel streams, not 6 (resolves #6)
10. **Add onboarding activation stub** in Round 2-3 (resolves #9)

### Scope cuts for timeline:
11. **Cut Writing Stats** from v1 (resolves #22 partially)
12. **Trim Import/Export** — drop EPUB, keep zip + markdown only
13. **Prose Analysis → stretch goal** unless headline differentiator
