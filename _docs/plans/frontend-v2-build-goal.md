# Goal: Build frontend-v2 to a consistent, working app

Status: active · Owner: product-lead (autonomous, checkpointed) · Started 2026-05-29

## North star
Build `frontend-v2/` into a working, visually-consistent application that
faithfully realizes the design language in `_docs/design/`. Aesthetic =
**literary & calm** ("paper"). The bar is not "it compiles" — it's "a careful
human looks at it and it feels coherent and good."

## Source of truth
- **Design intent:** `_docs/design/` (foundations, interaction, layouts).
- **Conventions / invariants:** the `AGENTS.md` hierarchy under `frontend-v2/`.
- When code and spec disagree, the spec wins — unless the spec is wrong, in
  which case STOP and raise it (don't silently diverge).

## Scope boundary
In scope: `frontend-v2/` UI — primitives, feature components, editor surfaces,
the Phase 6 layout shells, and wiring them to real data.
Out of scope (escalate before touching): the v1 `frontend/`, backend contracts,
inventing new design-token *values*, and any schema/infra decision.

## Phases — run each fully, then PAUSE for checkpoint
Work autonomously *within* a phase. At each phase boundary, STOP and present
before/after evidence; wait for explicit human OK before starting the next.
For construction phases, also checkpoint the *approach* BEFORE building.

1. **Primitives consistency** — `components/ui` fully token-driven
   (elevation, radius, focus ring, height, spacing, color). [in progress]
2. **Feature components** — threads, docs, activity, editor surfaces to the
   same bar.
3. **Phase 6 layouts** — app-shell + mode shells + routing per
   `design/layouts/`. **Checkpoint the structural approach before coding.**
4. **Wire real data** — WS / Yjs / query integration.

## Definition of Done (required per phase AND overall)
1. **COMPLETE** — every item in the phase surface realizes the design spec.
   No partials, no TODOs, no "most."
2. **SELF-VERIFIED** — playwright render + computed-style checks pass against
   spec tokens, **light + dark**; `pnpm run lint` clean.
3. **INDEPENDENTLY REVIEWED & AGREED** — `@alignment-reviewer` (impl vs
   `_docs/design/`) AND `@reviewer` report no open findings at the goal's bar.
   Findings → fix → re-review, **max 2 rounds**. Not converged → STOP + escalate.

## Autonomy rules
- Inside a phase: decide and proceed; verify with playwright + computed styles.
- Reviewers gate *correctness/alignment*; the visual "feel" is surfaced via
  before/after screenshots for the human to ratify at each checkpoint.
- **ESCALATE (pause + ask) mid-phase IF:** a new token *value* is needed, a
  subjective aesthetic call, a spec contradiction, or an architectural choice
  not settled by the spec.
- Never skip a between-phase checkpoint. Never start a construction phase
  without approval of the approach.

## HARD STOP — verification integrity
If ANY verification cannot actually run — Storybook won't build, playwright
can't drive it, lint fails on infra, or a reviewer spawn errors / returns
nothing — that is a **hard stop + escalate, NEVER a pass.**
**"Couldn't verify" ≠ "passed."**

## Verification method (the loop)
1. Run Storybook; drive it with `playwright-cli` (real events, not synthetic
   `.click()` — confirm overlays actually opened before trusting a shot).
2. Measure computed styles against spec tokens (light + dark).
3. Capture before/after screenshots of changed surfaces.
4. Spawn the reviewer gate. Fix → re-review (≤2 rounds) → checkpoint.

## Known state & operational learnings (read before working)
- **The control tier is already consistent.** Measured: button/input/textarea/
  select/toggle share 36px height, 6.4px radius, the same border token, Geist,
  and correct `--primary`/`--secondary`. Don't re-audit it from scratch — the
  payoff is in **surfaces/overlays and feature components**, where token drift
  hides.
- **playwright gotcha:** Radix overlays (dropdown, popover, select, dialog) do
  NOT open from a synthetic `el.click()`. Use real events —
  `playwright-cli click "getByRole('button', { name: '...' })"`. ALWAYS confirm
  the overlay actually opened (`querySelectorAll('[role=menu]').length`) before
  trusting a screenshot. A shot of a closed control is a false pass.
- **Verify by measurement, not just eye.** The espresso `--primary`
  (`oklch(0.190 …)`) looks "pure black" in compressed screenshots — it isn't.
  Read `getComputedStyle` values and compare to tokens; the eye lies on dark
  warm colors and on subtle shadows.
- **Storybook story coverage is itself a gap to watch.** Some stories don't
  exercise the real path (e.g. the Command Palette story renders a bare
  `Command`, not the elevated `CommandDialog`). When a story can't show the
  thing you changed, that's a coverage gap to log, not a reason to claim a pass.
- Storybook runs at `localhost:6006` (`cd frontend-v2 && pnpm storybook`).
  Story IDs: `curl -s localhost:6006/index.json`. Isolated render:
  `iframe.html?id=<story-id>&viewMode=story`.

## Phase log
- **Phase 1 (primitives — elevation): ✅ DONE (2026-05-29).**
  - Impl (p25): 18 files mapped from stock `shadow-*` to `--elevation-*` tokens;
    card `rounded-xl→lg`.
  - Review round 1: p26 alignment (6/6 pass, 1 Medium: backdrop opacity) +
    p27 adversarial (Request changes: popover shadow + 2 cleanups).
  - Spec decision (human): Popover keeps `--elevation-overlay` (consistent with
    sibling floating overlays). `elevation.md` updated — Popover added to Shadow
    Usage Map; token-table "popover" clarified as the surface color layer.
  - Fixes (p28): dialog/sheet backdrop `dark:bg-black/60` (50% Paper / 60%
    Espresso); removed dead card `elevated` variant; removed redundant
    toggle-group `shadow-none`.
  - Review round 2: p29 alignment **PASS (aligned)** + p30 adversarial **all
    findings resolved, no regressions**. NOTE: p30's session degraded into
    incoherent output *after* its verdict — the verdict itself is valid and
    corroborated by p29 + independent self-verification (grep, computed styles,
    light+dark visuals).
  - Self-verified: grep clean (only `shadow-elevation-*`/none remain), dropdown
    visibly floats, dialog backdrop 0.5→0.6 by measurement + eye, lint clean.
  - **Open follow-up (carry into Phase 2):** add a CommandDialog-path Storybook
    story — the Palette story renders bare `Command`, can't visually exercise
    the overlay lift.
  - Changes are UNCOMMITTED (p25 + p28 edits to `components/ui` + the
    `elevation.md` clarification) — commit as the Phase-1 checkpoint when ready.
