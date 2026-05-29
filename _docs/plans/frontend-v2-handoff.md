# Handoff: run the frontend-v2 build goal (clean agent bootstrap)

You are a **product-lead** picking up an autonomous, checkpointed build goal
with no prior conversation context. This document bootstraps you. Trust the
documents, not any memory — there is none.

## Read these first (in order)
1. **`_docs/plans/frontend-v2-build-goal.md`** — THE GOAL. North star, scope
   boundary, 4 phases, Definition of Done, autonomy rules, the
   verification-integrity hard-stop, and the operational learnings. This is your
   source of truth for *what done means*.
2. **`_docs/design/`** — the design language the app must realize (foundations,
   interaction, layouts). Source of truth for *design intent*.
3. **`frontend-v2/AGENTS.md`** + the per-seam `AGENTS.md` files — conventions and
   invariants you must not break. They point back to `_docs/design/`.

## How to work
- Execute the phases in order. Work autonomously **within** a phase; **PAUSE at
  every phase boundary** with before/after screenshots and wait for human OK.
  For construction phases (Phase 3+), checkpoint the *approach* before building.
- Honor the **Definition of Done** for each phase: complete → self-verified
  (playwright, light+dark, lint) → independently reviewed (`@alignment-reviewer`
  + `@reviewer` agree, ≤2 fix rounds, else escalate).
- **Verification integrity is absolute:** if a check can't actually run, that is
  a STOP + escalate, never a pass. "Couldn't verify" ≠ "passed."
- **Escalate (pause + ask) on:** a new token *value*, a subjective aesthetic
  call, a **spec contradiction/ambiguity**, or an architectural choice the spec
  doesn't settle. (Real example below — phase 1 hit one.)

## The verification loop (proven)
1. `cd frontend-v2 && pnpm storybook` → `localhost:6006`. Story IDs:
   `curl -s localhost:6006/index.json`. Isolated render:
   `iframe.html?id=<story-id>&viewMode=story`.
2. Drive with `playwright-cli` using **real events**
   (`playwright-cli click "getByRole('button',{name:'…'})"`), NOT synthetic
   `el.click()` — Radix overlays won't open from synthetic clicks. **Confirm the
   overlay actually opened** (`querySelectorAll('[role=menu]').length`) before
   trusting any screenshot.
3. Measure `getComputedStyle` against spec tokens (the warm espresso
   `--primary` looks "black" in screenshots — verify by value, not eye). Check
   **light AND dark**.
4. Spawn the reviewer gate. Fix → re-review (≤2 rounds) → checkpoint with the
   human.

## Current state (as of 2026-05-29)
- **Phase 1 (primitives — elevation):** implemented (p25), self-verified
  (grep clean, light+dark computed styles, dropdown visibly floats, lint clean),
  and reviewed (p26 alignment, p27 adversarial). **NOT yet closed** — resolving
  the review findings is your immediate frontier:
  1. **OPEN DECISION (escalated to human):** does the Radix **Popover**
     component get `shadow-elevation-overlay` (consistent with its sibling
     floating overlays — dropdown/context-menu/command) or `--elevation-none`
     (the token table lists "popover" there)? The spec is ambiguous; this is a
     human call. Once decided, also update `_docs/design/foundations/
     elevation.md` to disambiguate, then re-review.
  2. **FIX:** dialog/sheet backdrop opacity must be theme-specific — `bg-black/50`
     (Paper) / `bg-black/60` (Espresso, `dark:`). Currently fixed at `/50`.
  3. **CLEANUP:** remove (or intentionally keep) card's now-inert `elevated` CVA
     variant; drop the redundant `shadow-none` in `toggle-group`.
- **Phases 2–4:** not started. Note from the phase-1 audit: the **control tier
  (button/input/select/toggle/etc.) is already token-consistent** — focus your
  energy on surfaces, overlays, and feature components, where drift hides.
- **Known coverage gap:** the Command Palette story renders a bare `Command`,
  not the elevated `CommandDialog` path — add a story that exercises the real
  overlay path so the lift is visually testable.

## How to start
1. Confirm reality before acting: `git -C <repo> status`, read the goal doc's
   phase log, and check the p26/p27 verdicts if still available.
2. Resolve the three phase-1 findings above (escalate #1 if the human hasn't
   already decided it).
3. Re-run the reviewer gate; when both agree and the human ratifies the visual,
   mark phase 1 done in the phase log and checkpoint before Phase 2.

## Do NOT
- Touch the v1 `frontend/` (still production), backend contracts, or schema.
- Invent new design-token *values* (escalate instead).
- Skip a phase checkpoint or start a construction phase without approval.
- Report any phase done without the full DoD satisfied — especially the
  independent-review gate and verified light+dark visuals.
