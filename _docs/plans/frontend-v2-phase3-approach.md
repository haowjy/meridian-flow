# Phase 3 — Layouts: Structural Approach (PROPOSAL — needs human approval before coding)

Status: proposed · Owner: product-lead · 2026-05-29
Per the build goal, Phase 3 is a **construction phase**: the structural approach
must be approved before any code is written. This is that proposal. No layout
code exists yet (`src/layouts/` is empty scaffolding).

Sources: `_docs/design/layouts/{overview,agents,converse,studio}.md`,
`frontend-v2/src/layouts/AGENTS.md`, `_docs/design/components.md`,
`foundations/responsive.md`.

## Scope reality: Phase 3 is bigger than "wire up shells"
The layout shells depend on **composites that don't exist yet**. These are
specified in `components.md` but unbuilt:
Rail, BottomNav, StatusBar, FileExplorer, WorkItemCard, PanelResizeHandle,
BottomSheet, and the `shared/` adapters (pane wrapper, resizable adapter,
drawer, overlay toggle). So Phase 3 = build composites → assemble shells.

## Proposed sub-phase order (Storybook-first, UI-first, data-last)
1. **3a — Shared composites & app-shell chrome.** Rail, BottomNav, StatusBar,
   PanelResizeHandle, BottomSheet, `shared/` adapters. Each with stories,
   token-consistent, light+dark. (Highest reuse; everything else depends on these.)
2. **3b — App shell + mode-switch controller.** CSS grid (`48px 1fr / 1fr 24px`
   desktop; `1fr / 1fr auto` mobile), all-three-mounted strategy, CSS visibility
   toggle, focus restore, `aria-live` mode announce. Mode state behind a thin
   `useActiveMode` hook (see Decision 1).
3. **3c — Active/Inactive Work Contract.** `ShellVisibilityContext`; retrofit the
   already-built `FloatingScrollLayout`, streaming animations, and `RotatingText`
   to pause when their shell is inactive (see Decision 3).
4. **3d — Mode shells**, in order Studio → Converse → Agents (Studio reuses the
   most existing editor work; Converse reuses threads + chat-scroll; Agents needs
   the new WorkItemCard + dashboard). Built against **mock data** (reuse each
   feature's existing mock factories).
5. **3e — Responsive tiers.** Phone/Tablet/Desktop shell shapes; drawers/sheets
   for secondary content on Phone; viewport queries for shell, container queries
   for pane internals.

Each sub-phase self-verified (Storybook + computed styles light+dark + lint) and
reviewer-gated, with a mini before/after at sub-phase ends. Full phase checkpoint
at the end. (If you'd rather not checkpoint every sub-phase, say so — default is
I run 3a–3e autonomously and checkpoint once at the Phase-3 boundary.)

## Structural decisions that need your steer (the spec under-determines these)

### Decision 1 — Routing scope in Phase 3
The layout spec says mode is **URL-driven via TanStack Router**. But the
frontend-v2 build order lists **Routes (TanStack Router, URL sync, auth) as a
separate Phase 8**, and the build-goal's Phase 4 is "wire real data."
- **Proposed (recommended):** Build the mode-switch controller against a thin
  `useActiveMode()` abstraction now (CSS toggle + focus restore + visibility
  contract). Defer real TanStack Router URL wiring + auth to the data/routes
  phase. Keeps Phase 3 visual and decoupled from routing/auth.
- Alternative: pull full TanStack Router into Phase 3 now (more upfront coupling;
  earlier URL/bookmark fidelity).

### Decision 2 — Data posture in Phase 3
Per "UI-first/data-last," shells render from **mock factories** (the ones each
feature already ships for its stories), not live WS/Yjs. Real data is Phase 4.
- **Proposed (recommended):** mock-data shells in Phase 3; defer live wiring.
- This means the Phase-3 "working app" is visually complete but not yet
  data-connected — confirm that matches your definition of the Phase-3 boundary.

### Decision 3 — Active/Inactive Work Contract touches Phase-2 components
Hidden shells must pause non-essential work (streaming animations,
`ResizeObserver`/`rAF` loops, auto-scroll). Implementing this means **modifying
already-built, already-reviewed feature components** (`FloatingScrollLayout`,
`RotatingText`, streaming UI) to subscribe to a visibility context.
- **Proposed:** introduce `ShellVisibilityContext`; components read it and idle
  when inactive. This is in-scope per the spec but does edit Phase-2 surfaces —
  flagging so it's not a surprise.

## Definition of Done (Phase 3)
Same three-part DoD as every phase: COMPLETE (all shells + composites realize
`design/layouts/` + `components.md`), SELF-VERIFIED (Storybook + computed styles
light+dark + lint), INDEPENDENTLY REVIEWED (alignment + adversarial agree, ≤2
rounds). Mode switching instant (0ms), all-mounted, state survives switch,
inactive shells inert + paused.
