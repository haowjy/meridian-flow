# Full-System Review Synthesis (Round 2)

8 reviewers (6x GPT-5.4, 2x GPT-5.2), each with a different focus area. All 8 returned "request changes."

## Spawn Reference

| Spawn | Model | Focus | Severity |
|-------|-------|-------|----------|
| p104 | GPT-5.4 | Cross-feature integration & data flow | 5 HIGH, 2 MEDIUM |
| p105 | GPT-5.4 | Backend architecture & API completeness | 1 CRITICAL, 5 HIGH, 1 MEDIUM |
| p106 | GPT-5.4 | Frontend architecture & state management | 1 CRITICAL, 7 HIGH, 2 MEDIUM |
| p107 | GPT-5.4 | Security, billing & trust boundaries | 1 CRITICAL, 7 HIGH, 1 MEDIUM |
| p108 | GPT-5.4 | Implementation plan & dependency accuracy | 1 CRITICAL, 5 HIGH, 1 MEDIUM |
| p109 | GPT-5.2 | UX coherence, layout & responsive | 2 CRITICAL, 5 HIGH, 4 MEDIUM, 2 LOW |
| p110 | GPT-5.4 | Collab/Editor/Threads deep integration | 1 CRITICAL, 4 HIGH |
| p111 | GPT-5.2 | Coder-readiness & completeness | 6 BLOCKS, 11 SLOWS, 3 MINOR |

**Totals:** 8 CRITICAL, 39 HIGH, 11 MEDIUM — but many are the same issue seen from different angles. After dedup, there are **7 distinct critical themes** and **~15 distinct high findings**.

---

## CRITICAL Findings (block implementation)

### C1. Undo model contradiction (p106, p110, p111, prior p82)
**Flagged by:** 4 reviewers independently — the most-confirmed finding.

`collab-v2-integration.md` says Cmd+Z is "standard CM6 undo." `editor-direction.md` and `undo.md` say CM6 undo is disabled, Y.UndoManager is the only source of truth. Current code only tracks `ytext`, not `_proposal_status`, so accept/reject falls off the undo stack regardless.

**Decision needed:** Y.UndoManager over `Y.Text('content')` + `Y.Map('_proposal_status')` as sole undo source. CM6 built-in undo disabled in document editor, enabled in chat composer (independent local history).

**Action:** Update `collab-v2-integration.md` to match. Publish undo matrix: document editor (Y.UndoManager), chat input (CM6 local), mode switch (preserve document stack).

**Status:** RESOLVED IN PRINCIPLE (from prior round) — needs doc scrub.

---

### C2. Restore/reconnect doesn't destroy stale Y.Doc (p110)
**Flagged by:** R7 (collab deep dive).

When backend broadcasts `document:restored`, the frontend runtime preserves the in-memory Y.Doc across reconnect. Yjs sync can add missing structs but cannot subtract the post-restore local structs the server deleted. Client keeps stale text and stale undo entries.

**Action:** Make `document:restored` a hard epoch change: destroy session runtime, discard Y.Doc + undo state, reacquire fresh session. Add this to the collab frontend spec.

**Status:** OPEN — needs design + code change.

---

### C3. Project WebSocket has no project-access authorization (p107)
**Flagged by:** R4 (security).

`bootstrapAuth` verifies JWT but never checks project ownership before registering the socket. Any authenticated user with a project UUID can subscribe to another user's collab stream and receive full proposal payloads including `documentId`, `threadId`, `yjsUpdate`.

**Action:** Require `CanAccessProject` on WS connect, bind broadcasts to authorized user/project session. **Fix before v1 launch — this is a data leak.**

**Status:** OPEN — existing bug in current code, not just a design gap.

---

### C4. Restore endpoint has no ownership authorization (p105)
**Flagged by:** R2 (backend).

`POST /api/turns/{id}/restore` neither checks turn/thread/project ownership before mutating documents. Any authenticated user with a turn UUID can restore across projects.

**Action:** Add ownership chain validation: `turn -> thread -> project -> owner` before listing bookmarks or restoring state.

**Status:** OPEN — existing bug in current code.

---

### C5. Keyboard shortcut namespace triple-booked (p109, p108, p111)
**Flagged by:** 3 reviewers.

`Cmd+1/2/3` claimed by mode switching (layout), tab switching (studio chrome), AND editor headings. `Cmd+K` claimed by command palette AND editor link insertion.

**Action:** Publish a single "Keyboard Shortcuts v1" policy doc. Proposed resolution: `Cmd+Shift+1/2/3` for modes, `Cmd+1-9` for tabs, editor headings via toolbar only, `Cmd+K` for command palette (editor link uses toolbar or `Cmd+Shift+K`).

**Status:** OPEN — needs decision artifact before Round 1.

---

### C6. Thread navigation has no surface in layout diagrams (p109)
**Flagged by:** R6 (UX).

Threads spec requires "thread list per work item" and fast switching, but Converse layout shows only "Thread (primary) + Editor (secondary)" — no list/selector. Studio "Chat sidecar" doesn't define whether it includes thread list. Work items add a second dimension (work item selector) with no layout placement.

**Action:** Define thread switcher contract: persistent header row in thread pane/sidecar with work-item selector + thread selector. Define drawer behavior for Medium/Compact.

**Status:** OPEN — needs layout update.

---

### C7. `.work/` vs `.meridian/work/` path inconsistency (p108, confirmed by user)
**Flagged by:** R5 (implementation plan).

Multiple docs still reference `.work/` while the canonical path is `.meridian/work/<slug>/`. Agent tools, work items, autonomy map, and implementation plan are inconsistent.

**Decision:** `.meridian/work/<slug>/` on disk, `$MERIDIAN_WORK_DIR` and `$MERIDIAN_FS_DIR` env vars as session shortcuts. **User confirmed.**

**Action:** Scrub all docs for `.work/` references. Replace with `.meridian/work/`.

**Status:** RESOLVED — needs doc scrub only.

---

## HIGH Findings (fix before or during implementation)

### H1. Shell keep-alive creates duplicate resource acquisitions (p104, p106)
If StudioLayout and ConverseLayout both stay mounted and both render an EditorPane, you get two live editors/WebSocket subscriptions per project. Current frontend hooks acquire resources on mount and release on unmount.

**Action:** Define singleton pane ownership model above layout shells. One live editor/thread controller per project, shared across mounted shells.

### H2. Missing backend API contracts (p105, p104, p111)
Billing has no concrete routes. Work items name CRUD but no paths/payloads. Explorer/Settings have no "internal tree" API. Search points at wrong endpoint. 402 error path undocumented.

**Action:** Write backend contract doc covering every Round 0/1 endpoint before spawning coders.

### H3. React Query vs Zustand authority conflict (p106)
Toolchain picks React Query for threads/tree, but architecture says Zustand stores own state. Without a hard split, caches and invalidation logic will duplicate.

**Action:** Define rule: React Query owns server snapshots (cache/refetch), Zustand owns UI/optimistic/ephemeral state. Entity collections never duplicated.

### H4. Billing credit gate not anchored at single boundary (p107, p105)
Design splits billing between middleware and per-inference-step checks. Middleware only runs once per HTTP request — can't stop later tool rounds. Multiple direct provider call sites exist.

**Action:** Make step-level billing authoritative inside streaming execution. Wrap provider access behind one metered interface. Middleware is admission-only.

### H5. FIFO consumption audit trail lossy (p105)
A single deduction can span multiple lots. Current schema assumes one lot per transaction row, making the audit trail either lossy or duplicated.

**Action:** Add per-lot allocation rows beneath parent transaction, or make transactions one-row-per-lot with shared consumption group ID.

### H6. Data layer has no consumer API contract (p106, p111, p108, p104)
`updateState -> Dexie.write + POST -> reconcile` is conceptual. No typed interface for features to call. Dexie schemas not defined.

**Action:** Publish typed resource contracts for each state class: local-first Yjs docs, server-authoritative cached entities, streaming thread state. Include Dexie table schemas.

### H7. Frontend import boundaries prose-only (p106)
No automated enforcement. Existing code already shows cross-boundary imports. Will decay immediately under parallel implementation.

**Action:** Add `eslint-plugin-boundaries` with restricted-path rules before Round 1 frontend work.

### H8. Decoration conflict matrix still missing (p106, p110, p111)
4-layer decoration stack specified but conflict behavior undefined. `Decoration.replace` widgets in live preview/blocks clash with hunk marks. Hunks inside rendered blocks have no visual anchor.

**Action:** Write the actual conflict matrix. Define fallback for hunk intersecting replaced/hidden-syntax range.

### H9. Grouped hunk identity doesn't span proposals/documents/turns (p110)
Current review package is proposal-local. No authoritative object for "this hunk spans P1+P2 in doc A and belongs to turn T." Thread can't render accurate partial/mixed status.

**Action:** Add first-class grouped-hunk aggregate model shared by editor and thread UI.

### H10. Interrupted turns leave orphaned proposals (p110)
`InterruptTurn` marks turn cancelled but doesn't roll back created proposals or applied document updates. No "partial turn" status, no hunk cleanup rule.

**Action:** Define interrupted-turn semantics: `cancelled_partial` status, rules for already-created proposals, cleanup policy.

### H11. Stripe webhook missing signature verification (p107)
Design only defines idempotency via UNIQUE constraint. No mention of Stripe signature verification, timestamp tolerance, or matching webhook to server-created checkout record.

**Action:** Add webhook security requirements: verify signatures, validate timestamps, fetch/verify session from Stripe.

### H12. Free-credit grant timing contradictory (p108, p105, p107)
Billing says email users wait for verification. Auth, onboarding, and plan say instant grant. This changes endpoint behavior and abuse model.

**Action:** Canonical policy: OAuth = instant 300 credits. Email/password = credits after email verification. Update auth.md, onboarding.md, and plan to match.

### H13. Project WS outlives JWT expiry (p107)
Document WS has periodic JWT recheck; project WS does not. Connection can persist indefinitely after token expiry.

**Action:** Add JWT expiry check to project WS heartbeat loop, matching document WS pattern.

### H14. `.agents/` namespace not enforced (p107)
Current namespace parser only recognizes `.meridian` and `.session`. Agent tool permission boundary for `.agents/` is design-only.

**Action:** Make `.agents` a first-class namespace. Enforce read-only policy for agents.

### H15. Medium/Compact responsive behavior undesigned (p109, p108)
Breakpoints exist, intent clear, but no spec for: toggle placement, drawer interaction, overlay stacking, focus management, or compact rail behavior.

**Action:** Add responsive interaction contract per shell: explicit toggles, drawer specs, focus return rules.

---

## MEDIUM Findings (address during implementation)

### M1. Store inventory missing (p106)
"One store per domain" stated but never turned into actual inventory. No store names, APIs, or cross-store contracts.

### M2. Focus management model missing (p109)
No rules for where focus goes on incoming events, overlay open/close, palette actions. Writing flow risk.

### M3. Mention entity contract not unified (p104)
Explorer "Add to Thread", chat pills, wiki-links, and @mention chips don't share one identity contract.

### M4. Agents/Skills migration docs conflicting (p105)
One doc says "no DB migration" and drops table; plan says dual-read with deferred drop; code assumes `.meridian/skills`.

### M5. Explorer/Tabs preview-tab contract inconsistent (p109, p111)
Explorer + Tabs require preview semantics; Studio Chrome says "single-click opens file" without preview. DnD deferred but still in Explorer scope.

### M6. Storybook scenarios lack concrete mock specs (p111)
Stories named but mock data, user actions, and assertions not specified.

### M7. frontend-v2 still ships Base UI + Lucide (p106)
Design says Radix + shadcn + Phosphor but rebuild code hasn't been updated.

### M8. Import/Export doc still includes EPUB (p108, p111)
Plan cuts EPUB; feature doc still includes it.

### M9. Thread spec includes @mentions despite being moved to Round 2b (p108)

### M10. Autonomy map stale (p108)
Still references reservation billing, old F1 scope, claims ~15 fully autonomous streams.

### M11. Collab docs reference nonexistent files (p111)
`architecture.md`, `local-first-authority.md`, `schema-design.md`, etc. don't exist.

---

## Action Plan — What to Fix Before Round 0

### Must-fix before ANY implementation

1. **Security bugs (C3, C4, H13, H14)** — Project WS auth, restore ownership, JWT expiry, `.agents/` namespace. These are bugs in current code. Fix immediately.

2. **Backend API contract doc (H2)** — Write one doc covering every Round 0/1 endpoint: billing routes, work item CRUD, tree API for hidden namespaces, 402 error shape. Without this, backend coders guess at API surface.

3. **Doc scrub (C1, C7, M4, M8, M9, M10, M11)** — Kill contradictions: undo model, `.work/` paths, EPUB scope, @mentions in F7, stale autonomy map, broken cross-refs. This is mechanical — one pass through all docs.

### Must-fix before Round 1 (frontend work starts)

4. **Shortcut policy (C5)** — Publish keyboard namespace before F1/F4/F11a claim bindings.

5. **Shell keep-alive ownership (H1)** — Define singleton pane model before F11a layout shells.

6. **Data layer contract (H6)** — Publish typed interface before C1 consumers build against it.

7. **React Query vs Zustand rule (H3)** — Decide authority split before any feature store work.

8. **Thread switcher UX (C6)** — Define layout placement before F11a builds the shells.

9. **Responsive interaction contracts (H15)** — Define drawers/toggles per shell before F11a.

### Must-fix before Round 2 (feature work starts)

10. **Decoration conflict matrix (H8)** — Write before F4 Editor and F10 Collab implement layers.

11. **Billing gate architecture (H4, H5)** — Anchor at streaming execution, fix FIFO audit, before A1 billing coder starts.

12. **Restore epoch change (C2)** — Design before F10 Collab frontend implements reconnect.

13. **Grouped hunk identity (H9)** — Define before F10 builds proposal-local review.

14. **Interrupted turn semantics (H10)** — Define before F7 Threads implements cancel.

15. **Import boundary enforcement (H7)** — Add eslint rules before parallel frontend streams.
