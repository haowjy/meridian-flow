# Design Spec Changelog

**Date:** 2026-05-29  
**Version:** 1.0 (authoritative — all product decisions resolved)

## A. Confirmed Decisions (5 items folded in)

### A1. Multiple sessions per project
- **Resolution:** Confirmed. A project has multiple sessions (bounded units of related work).
- **Changes:**
  - `layouts/agents.md` §Data Model: replaced "unresolved" note with normative Decision box
  - `vocab.md` Discrepancy #2: marked RESOLVED
  - `overview.md` §Decisions for Sign-Off: moved item #10 to "Resolved" subsection

### A2. Converse→Studio tabs: hybrid preview→promote
- **Resolution:** VS Code preview-tab pattern. Review opens transient preview; promotes on edit/hunk action/pin/double-click.
- **Changes:**
  - `layouts/converse.md` §Interaction Flows: "Review" opens preview; thread switching restores draft; doc links open preview
  - `layouts/converse.md` §Editor Header: added italic title for preview, pin button
  - `layouts/studio.md` §Tab Bar: added `isPreview` flag, preview-tab lifecycle
  - `layouts/studio.md` §Tab State Persistence: preview tabs not persisted across reload
  - `layouts/overview.md` §Cross-Mode Interactions: replaced "always create tab" with preview→promote
  - `interaction/navigation.md` §Tab Management: added preview tab section
  - `components.md` §TabBar: added preview tab states, pin button
  - `overview.md` §Decisions for Sign-Off: moved item #11 to "Resolved" subsection

### A3. Wiki-links carry forward
- **Resolution:** Confirmed. `[[page]]` support preserved in v2 as decoration layer.
- **Changes:**
  - `interaction/editor.md` §Wiki-Links: removed "sign-off item #12" note; reconciled layer number with canonical table
  - `interaction/proposals-review.md` §Decoration Layer Ordering: added wiki-link layer (2) to canonical table
  - `overview.md` §Decisions for Sign-Off: moved item #12 to "Resolved" subsection

### A4. Focus mode: included
- **Resolution:** In scope. Core = hide chrome; paragraph dimming = optional refinement. Web-safe shortcut: `Ctrl+Shift+Escape`.
- **Changes:**
  - `interaction/editor.md` §Focus Mode: removed "Proposed/deferred" framing; separated core vs. optional; fixed shortcut
  - `interaction/navigation.md` §Full Keyboard Map: added Focus Mode section with `Ctrl+Shift+Escape`
  - `overview.md` §Decisions for Sign-Off: moved item #13 to "Resolved" subsection

### A5. Mobile: deferred
- **Resolution:** Confirmed deferred. Future direction noted as non-normative.
- **Changes:**
  - `overview.md` §Decisions for Sign-Off: moved item #14 to "Resolved" subsection with future direction note

---

## B. Review Remediations (all 18 findings)

### High

#### B1. Web-safe keyboard map
- **Files:** `interaction/navigation.md` (major rewrite), `layouts/studio.md`, `layouts/converse.md`, `components.md`
- **Changes:**
  - Replaced all browser-uninterceptable shortcuts: `Cmd+W`→`Ctrl+W`, `Cmd+N`→`Ctrl+Shift+N`, `Cmd+T` removed, `Cmd+Tab`→`Ctrl+Tab`
  - `Cmd+P` kept with explicit `preventDefault` note
  - `Cmd+1/2/3` kept (interceptable, justified as primary navigation)
  - Added "Future Desktop Wrapper" appendix with ideal native keymap for future reference

#### B2. One canonical shortcut table
- **Files:** `interaction/navigation.md`, `layouts/studio.md`, `layouts/converse.md`
- **Changes:**
  - Created single canonical table in `navigation.md` §Full Keyboard Map with:
    - Web-safety pass result
    - Shortcut precedence rules (editor > review > mode-specific > global)
    - `Escape` precedence rules
  - Removed local shortcut tables from `studio.md`, `converse.md` → replaced with references to canonical table
  - Resolved all conflicts: `Cmd+1/2/3` = mode only; Focus mode = `Ctrl+Shift+Escape`; `Ctrl+K` = context-dependent with defined precedence

#### B3. (Closed by Section A — removed provisional framing)
- `overview.md`: status changed to "Authoritative," all open decisions moved to "Resolved"

#### B4. Studio sidecar scoping
- **Files:** `layouts/studio.md`, `layouts/overview.md`
- **Changes:**
  - Default = manual thread selection (NOT auto-scoped)
  - Added explicit "Discuss current document" action (`Cmd+Shift+D`, button in sidecar header)
  - Replaced "scoped to document's context" in overview.md with the manual + explicit action model

#### B5. Thread draft persistence
- **Files:** `layouts/converse.md` §Interaction Flows
- **Changes:**
  - Thread switching now RESTORES the target thread's saved composer draft
  - Only newly created threads start with empty composer
  - Removed "Composer clears and refocuses" language

#### B6. Proposal review scope = document-scoped
- **Files:** `interaction/proposals-review.md`, `layouts/studio.md`
- **Changes:**
  - All pending hunks for active document visible regardless of originating thread
  - Review toolbar shows per-hunk provenance (originating thread/proposal ID)
  - Undo changed from per-thread to document-level (CM6/Yjs undo stack)
  - Updated "Review Flow by Mode" for Studio to reflect document-scoped model

#### B7. One canonical decoration-layer ordering
- **Files:** `interaction/proposals-review.md` §Decoration Layer Ordering, `interaction/editor.md`
- **Changes:**
  - Created single canonical table in `proposals-review.md` (layers 0–6)
  - Added wiki-link layer at position 2
  - Fixed `editor.md` "layer 1.5" → references canonical table
  - This table is now the authoritative source for all layer ordering

#### B8. Links always use accent-text
- **Files:** `interaction/editor.md` §Syntax Highlighting
- **Changes:**
  - `link`/`url` syntax highlighting changed from `accent-fill` → `accent-text`
  - Added explicit rule note: all teal text = `accent-text`; `accent-fill` = non-text only

#### B9. Inactive mode shells accessibility
- **Files:** `layouts/overview.md` §CSS Mounting Strategy, `components.md` §Accessibility Patterns
- **Changes:**
  - Added canonical rule: inactive shells = `display:none` + `aria-hidden="true"` + `inert`
  - Explicit focus restoration on mode switch
  - Referenced from `components.md` Accessibility section
  - Added principle #5 to `navigation.md` Navigation Principles

#### B10. Elevation foundation
- **Files:** NEW `foundations/elevation.md`, `foundations/tokens.md`
- **Changes:**
  - Created `foundations/elevation.md` with minimal three-level token scale (none/subtle/overlay)
  - Added elevation tokens to `tokens.md` semantic tokens table
  - Added Tailwind `@theme` mapping for elevation
  - Converted all ad-hoc shadows across the spec to named tokens:
    - `interaction/editor.md`: formatting toolbar → `--elevation-overlay`
    - `interaction/proposals-review.md`: hunk widget, review toolbar → `--elevation-overlay`
    - `layouts/converse.md`: composer shadow → `--elevation-subtle`
  - Updated doc tree in `overview.md`

### Medium

#### B11. 44px touch targets
- **Files:** `components.md` §Shared Component Patterns
- **Changes:**
  - Kept visual sizes (rail 36, tabs 36, tree rows 28)
  - Documented invisible hit-padding extending to 44px
  - Narrowed rule to cover where padding applies vs. where 44px is literal
  - Added explicit exception for PanelResizeHandle (precision drag area)
  - Added rail hit area documentation

#### B12. Canonical home for status data
- **Files:** `components.md` §StatusBar, `layouts/studio.md` §Editor Chrome
- **Changes:**
  - Global connection status → StatusBar only (removed from editor chrome)
  - Word count → editor chrome/document title header only (removed from StatusBar)
  - Updated `layouts/overview.md` "What Changes on Mode Switch" table

#### B13. Fuzzy file open pattern
- **Files:** `layouts/studio.md` §Fuzzy File Open, `interaction/navigation.md` §File Navigation
- **Changes:**
  - Picked ONE pattern: lightweight cmdk popover (not modal dialog)
  - Removed "centered dialog with backdrop" language
  - Added explicit consistency note referencing Navigation Principles

#### B14. PanelResizeHandle keyboard semantics
- **Files:** `components.md` §PanelResizeHandle
- **Changes:**
  - Defined as focusable `separator` with `aria-orientation`, `aria-valuenow/min/max`
  - Added arrow key resizing (20px / 100px with Shift)
  - Added `Enter` = reset to default, `Escape` = cancel
  - Added to ARIA patterns table

#### B15. Functional color hardening
- **Files:** `foundations/color.md`, `foundations/tokens.md`
- **Changes:**
  - Added `--destructive-foreground` token
  - Added `--destructive-foreground` to `tokens.md` semantic tokens and `@theme` mapping
  - Published full contrast matrix for badge/button/toast/text-on-fill states
  - Verified all functional text-on-fill pairings meet WCAG AA at all sizes
  - Resolved "verify per size" notes

#### B16. Editor focus treatment
- **Files:** `interaction/editor.md` §Editor Theme
- **Changes:**
  - Defined explicit keyboard-focus affordance on editor frame/header container (3px `--ring` at 50% opacity)
  - CM6 inner surface removes outline; frame provides the focus ring
  - Added Decision box with rationale

#### B17. Proposal lifecycle
- **Files:** `interaction/proposals-review.md` §Proposal Lifecycle, `interaction/threads-and-tools.md`, `layouts/agents.md`
- **Changes:**
  - Collapsed `proposed` and `pending` into single `pending` state
  - Removed `proposed` from lifecycle diagram
  - Removed separate badge variant for `proposed`
  - Added Decision box explaining the collapse
  - Updated agents.md and threads-and-tools.md for consistency

### Low

#### B18. Token discipline
- **Files:** `foundations/tokens.md`
- **Changes:**
  - Added "Token Discipline: Raw Value Whitelist" section
  - Explicitly defined which layout constants may remain raw (shell widths, hit areas, opacities, CM6 offsets, animation exceptions)
  - Rule: when a constant appears in two+ components, promote to token
  - Added elevation tokens to close the "elevation missing" gap

---

## Files Changed

| File | Change type |
|---|---|
| `design/overview.md` | Version/status, Sign-Off restructuring, doc tree |
| `design/foundations/color.md` | Destructive-foreground, contrast matrix, resolve verify-notes |
| `design/foundations/tokens.md` | Elevation tokens, destructive-foreground, token discipline whitelist |
| `design/foundations/elevation.md` | **NEW** — elevation/shadow foundation |
| `design/layouts/overview.md` | Inactive shell accessibility, cross-mode interactions (preview→promote, Discuss action), word count fix |
| `design/layouts/agents.md` | Multi-session normative, keyboard safety |
| `design/layouts/converse.md` | Preview tabs, thread draft persistence, keyboard ref, shadow token |
| `design/layouts/studio.md` | Preview tabs, keyboard ref, sidecar scoping, fuzzy open (popover), editor chrome, word count |
| `design/interaction/navigation.md` | **Major rewrite** — canonical keyboard map, web-safety pass, precedence rules, desktop wrapper appendix, preview tabs |
| `design/interaction/threads-and-tools.md` | Proposal lifecycle consistency |
| `design/interaction/proposals-review.md` | Document-scoped review, canonical layer order, doc-level undo, lifecycle collapse, elevation tokens, provenance |
| `design/interaction/editor.md` | Wiki-link layer, link→accent-text, focus mode (confirmed + optional dimming), editor focus treatment, elevation tokens |
| `design/components.md` | Preview tab states, 44px touch targets docs, PanelResizeHandle keyboard/ARIA, rail hit-padding, StatusBar deduplication, inactive shell accessibility ref |
| `vocab.md` | Discrepancy #2 resolved |

---

## Keymap + layer remediation (2026-05-29)

Two residual defects from the finalization pass, fixed in one pass.

### Fix 1 — `Mod` notation + web-safety blocklist

**Problem:** The B1 web-safety pass only fixed the macOS side (`Cmd+X` →
`Ctrl+X`), but on Windows/Linux browsers `Ctrl+` combos collide with the same
browser/OS chrome. The canonical table also mixed `Cmd+` and `Ctrl+` literally
(e.g., `Cmd+B` bold and `Ctrl+E` inline code in the same editor table) — a
reader couldn't tell what the Mac binding for inline code was.

**Changes:**

- **Adopted `Mod` notation throughout.** `Mod` = `Cmd` on macOS, `Ctrl` on
  Windows/Linux (CodeMirror / ProseMirror convention). Defined at the top of
  the canonical table in `navigation.md`.
- **Added reserved-combo blocklist** to `navigation.md` §Web-Safety Pass.
  None of these carry app actions: `Mod+N/T/W/Q`, `Mod+Shift+N/T/W`,
  `Mod+Tab`/`Mod+Shift+Tab`, `Mod+Shift+Escape`, `Mod+Shift+D`.
- **Reassigned broken bindings:**
  | Old (broken) | New | Action |
  |---|---|---|
  | `Ctrl+Shift+N` | `Mod+Shift+O` | New thread (Converse + Agents) |
  | `Ctrl+Shift+Escape` | `Mod+Shift+\` | Toggle focus mode |
  | `Ctrl+W` | *(no global keystroke)* | Close tab — affordance + middle-click only in web build |
  | `Ctrl+Tab` / `Ctrl+Shift+Tab` | `Mod+Shift+]` / `Mod+Shift+[` | Next / previous tab |
  | `Ctrl+Shift+T` | `Mod+Shift+Y` | Reopen last closed tab |
  | `Ctrl+Shift+D` | `Mod+Shift+G` | Discuss current document |
- **Rewrote Future Desktop Wrapper appendix** — now shows two categories:
  (a) desktop-native replacements for combos the browser blocks (`Mod+W`,
  `Mod+Tab`, `Mod+Shift+T`); (b) modifier-only swaps where the web-build
  `Mod` combo works as-is in a desktop wrapper.
- **Re-checked `Escape` precedence and `Mod+K` context rules** — still hold
  after renaming.

**Files changed:**

| File | Change |
|---|---|
| `interaction/navigation.md` | **Major rewrite** — `Mod` notation, blocklist, reassigned bindings, rewritten desktop appendix, all section headings |
| `interaction/editor.md` | Formatting toolbar shortcuts, focus mode toggle (`Mod+Shift+\`), `Mod+Click` wiki-link |
| `interaction/proposals-review.md` | Hunk action shortcuts, hunk navigation, document-level undo trigger, Edit flow |
| `layouts/studio.md` | Explorer toggle, sidecar toggle, Discuss shortcut, tab lifecycle, keyboard shortcuts section, fuzzy open heading, Decision box |
| `layouts/converse.md` | Keyboard shortcuts section |
| `layouts/agents.md` | Keyboard navigation section |
| `layouts/overview.md` | Mode switching trigger, Discuss shortcut, file tree comment |
| `components.md` | Rail mode shortcuts, TabBar close/reopen references |
| `overview.md` | Focus mode shortcut in Decisions section, file tree comment |

### Fix 2 — Decoration layer renumbering

**Problem:** `editor.md` slotted focus-mode paragraph-dimming at "layer 4.5"
(between proposal hunks and selection), but the canonical table in
`proposals-review.md` (layers 0–6) did not contain it. This was the same
fractional-layer anti-pattern B7 eliminated.

**Changes:**

- **Added focus-mode layer to the canonical table** in
  `proposals-review.md` §Decoration Layer Ordering as a real integer position
  (layer 5, between Proposal hunks and Selection).
- **Renumbered** the stack to clean contiguous 0..7:
  | Layer | Source | Change |
  |---|---|---|
  | 0–4 | Lezer, Live preview, Wiki-link, Block, Proposal | Unchanged |
  | 5 | **Focus-mode StateField** (new) | Paragraph dimming |
  | 6 | Selection | Was layer 5 |
  | 7 | Collab awareness | Was layer 6 |
- **Updated `editor.md`** §Focus Mode to cite the new integer position (layer
  5) and reference the canonical table — dropped "4.5" and all
  fractional-layer language.
- **Confirmed** wiki-link layer (2) and focus-dimming layer (5) are both
  present in the one canonical table. `vocab.md` only defines the general
  term (no enumeration to conflict).

**Files changed:**

| File | Change |
|---|---|
| `interaction/proposals-review.md` | Added focus-mode layer to canonical table; renumbered layers 5→6, 6→7; updated overlap rule references |
| `interaction/editor.md` | Replaced "layer 4.5" with "layer 5" + canonical table reference |

---

## Design contracts (2026-05-29)

Two architectural contracts that were emergent properties of the implementation
but not stated as explicit rules in the spec. Both are now normative.

### Contract 1 — Surface ownership & mirrored surfaces

**Files:** `interaction/editor.md`, `layouts/overview.md`, `layouts/studio.md`, `layouts/converse.md`

- Added `## Surface Ownership & Mirrored Surfaces` to `interaction/editor.md`
  with the ownership model (DocSession → ViewController, one live EditorView
  constraint), the Decision/Rationale/Rejected box, and supporting rules.
- Cross-referenced from `layouts/overview.md` §State Scoping (editor scroll
  and cursor position entries) and from `layouts/studio.md` §Editor Chrome
  and `layouts/converse.md` §Editor Content.

### Contract 2 — Inactive mode shells must pause non-essential work

**Files:** `layouts/overview.md`, `components.md`

- Added `#### Active/Inactive Work Contract` to `layouts/overview.md` §CSS
  Mounting Strategy with a Decision box, a two-column pause table (essential
  vs. paused work), and the Rationale/Rejected box.
- Updated the "React effects and subscriptions stay active" bullet in the
  same section to point to the new table.
- Updated `components.md` §Inactive Mode Shells with a one-line summary
  of the pause rules and a cross-reference to both the accessibility rule
  and the work contract in `layouts/overview.md`.

---

## Mobile / responsive design (2026-05-29)

Mobile is no longer deferred. The spec now treats Phone, Tablet, and Desktop
as co-equal design targets. This is the largest single change since the
initial spec — it adds a new foundation document, new composite components,
per-mode mobile layouts, touch editing, touch review, mobile chat, and a
gesture vocabulary.

### Decision change

**Decision #14 replaced.** "Mobile: deferred" → "Mobile: co-equal, all three
modes." The product posture in `overview.md` changes from "Desktop-first" to
"Responsive-first (desktop + mobile co-equal)." Decision #4 updated
accordingly.

### New files

| File | Content |
|---|---|
| `foundations/responsive.md` | **NEW** — Tier system (Phone/Tablet/Desktop), breakpoint detection, viewport/safe-area tokens, dynamic viewport units, touch target rules, state preservation rules, mounted-shell contract on mobile |

### Files changed

| File | Change type | Summary |
|---|---|---|
| `overview.md` | Updated | Product posture → responsive-first; decision #14 rewritten; doc tree updated with new files and mobile annotations |
| `vocab.md` | Updated | New "Responsive & mobile" section: Tier, BottomNav, AccessoryBar, Bottom sheet, HunkReviewSheet, Drawer, Safe area, Push navigation |
| `foundations/tokens.md` | Updated | New responsive shell tokens (`--bottom-nav-height`, `--accessory-bar-height`); @theme mapping additions; token inventory row; raw-value whitelist updated |
| `layouts/overview.md` | Major update | App shell now shows Desktop, Phone, and Tablet variants with diagrams; layout grid for BottomNav shell; mode switching includes BottomNav taps; responsive tiers rewritten from Expanded/Medium/Compact to Phone/Tablet/Desktop; PanelResizeHandle touch decision; mobile cross-mode interactions |
| `layouts/agents.md` | Updated | Responsive section rewritten: Tablet landscape split, Tablet portrait + Phone push navigation, session selector as bottom sheet, card layout on phone |
| `layouts/converse.md` | Updated | Responsive section rewritten: Tablet landscape split, Phone full-screen thread + push-navigation editor, composer positioning with visualViewport, thread selector as bottom sheet, preview→promote on phone |
| `layouts/studio.md` | Updated | Responsive section rewritten: Tablet landscape/portrait, Phone full-screen editor with FileExplorer drawer, sidecar bottom sheet, TabBar scrollable with long-press context, Discuss on touch, fuzzy file open on phone |
| `interaction/editor.md` | Major addition | New "Touch & Mobile Editing" section: native selection preservation, AccessoryBar spec (editing + review contexts), keyboard-as-viewport (caret keeping, dvh, inset handling), focus writing as phone default, wiki-links on touch, formatting without keyboard |
| `interaction/proposals-review.md` | Major addition | New "Touch Review" section: HunkReviewSheet bottom sheet, per-hunk sticky action bar, touch gestures for review (swipe with button fallbacks), batch actions on phone, inline diff rendering adjustments (stronger visual cues), edit flow on phone, tablet review |
| `interaction/threads-and-tools.md` | Updated | New "Mobile Chat Surface" section: medium density on phone, phrase/sentence-chunk streaming, send-vs-stop toggle, jump-to-latest pill, tool groups/agent detail as bottom sheets, branch navigation on phone |
| `interaction/navigation.md` | Major addition | New "Touch Gestures" section: canonical gesture table, gestures not used, discoverability rules (first-time tooltips, visual affordances), keyboard map scope on mobile (phone equivalents for every desktop shortcut); navigation principles updated for touch parity |
| `components.md` | Major addition | New mobile composites: BottomNav, AccessoryBar, HunkReviewSheet, MobileComposer. New "Existing Component Responsive Notes" section: Rail, TabBar, FileExplorer, StatusBar, PanelResizeHandle responsive behavior. ARIA table updated with BottomNav and AccessoryBar |

### Desktop decisions affected by mobile co-equality

These existing desktop decisions required clarification or minor adjustment
(no reversals):

1. **PanelResizeHandle is pointer-only.** On Phone/Tablet portrait, panes are
   full-screen or drawer/sheet — no drag-resize handles. This is a new Decision
   box in `layouts/overview.md`.

2. **Formatting toolbar scope narrowed.** On Phone, the floating formatting
   toolbar is replaced by the AccessoryBar (it would overlap native selection
   handles). On Tablet, the floating toolbar appears only when a hardware
   keyboard is connected. Decision in `interaction/editor.md` §Touch & Mobile
   Editing.

3. **StatusBar removed on Phone/Tablet portrait.** Connection status folds
   into the BottomNav "More" overflow. Word count was already in editor chrome,
   so no information is lost. This is a responsive note in `components.md`.

4. **Focus Mode scoping.** The existing Focus Mode (user-toggled, hides all
   chrome) is available on Tablet with keyboard. On Phone, a lighter "auto-focus"
   behavior (reduce chrome while typing, but keep BottomNav visible) is the
   default. This is a new Decision box in `interaction/editor.md`.

5. **"No navigation modals" principle narrowed.** On Phone, fuzzy file open and
   thread selectors become full-screen search views or bottom sheets — the
   phone screen IS the modal. The principle now says "No navigation modals on
   desktop." Updated in `interaction/navigation.md`.

---

## Mobile integration fixes (2026-05-29)

Close residual gaps in the mobile/responsive integration pass.

| # | Fix | Files changed |
|---|-----|---------------|
| 1 | Rewrote "Three modes behind the rail" to tier-neutral "Three modes behind the global mode navigation (Rail on Desktop, BottomNav on Phone)" | `interaction/navigation.md` |
| 2 | Added long-press touch path for FileExplorer tree-item context menu (context sheet, kebab fallback) | `layouts/studio.md` |
| 3 | Added long-press touch path for Agents work-item card context menu (context sheet, kebab fallback) | `layouts/agents.md` |
| 4 | Added canonical gesture rows for long-press → file-tree item and long-press → work-item card in the Touch Gestures table | `interaction/navigation.md` |
| 5 | Marked review-vocabulary discrepancy as RESOLVED; Keep/Edit/Discard is canonical | `vocab.md` |
| 6 | Expanded hover-disclosure rule to require touch-visible or long-press fallback on Phone/Tablet | `components.md` |
| 7 | Appended touch path to tab-close wording (long-press tab context sheet on Phone/Tablet) | `components.md` |
| 8 | Added generic **BottomSheet** composite with structural slots (detents, drag-to-dismiss, grabber, safe-area); made `HunkReviewSheet` a documented specialization; canonicalized `BottomSheet` (PascalCase) in vocab | `components.md`, `vocab.md` |
| 9 | Added Decision/Rationale/Rejected box for StatusBar removal on Phone/Tablet portrait | `components.md` |
| 10 | Added top-level Decision/Rationale/Rejected box for the mobile chat surface (medium density, chunked streaming, send-vs-stop, jump-to-latest, bottom sheets) | `interaction/threads-and-tools.md` |

---

## Research integration: enforcement, a11y & perf guardrails (2026-05-29)

Three web-research passes (`research/web-component-consistency.md`,
`research/web-typography-systems.md`, `research/web-smoothness-motion.md`)
confirmed the spec is directionally correct but surfaced enforcement and
guardrail gaps. Documented as normative sections in the three relevant
docs. No prior decisions reversed — all additions are new guardrails,
not changes to existing rules.

### Addition 1 — Enforcement & Consistency Policy → `components.md`

- Added `## Enforcement & Consistency Policy` section after Shared Component
  Patterns, with five subsections:
  - **Override Policy:** `className`/`twMerge` as boundary escape hatches;
    `twJoin` for internal composition; CVA variant factory mandate.
    Decision/Rationale/Rejected box.
  - **No-Orphan-Styles Rule:** Repeated style patterns must graduate into
    tokens, variants, or shared composites. Decision/Rationale/Rejected box.
  - **Lint Contract (CI Gate, `error` Level):** Five rules across
    `eslint-plugin-tailwindcss`, custom ESLint, and Stylelint. Ban arbitrary
    values, ban raw hex, require `data-slot`, require variant factories.
  - **Visual Gate (Chromatic):** Required PR check gated by branch protection.
    Decision/Rationale/Rejected box.
  - **Story Coverage Contract:** Every supported state deserves a story;
    minimum coverage checklist (loading/empty/error/interaction/variants).
    Decision/Rationale/Rejected box.
- Cited `research/web-component-consistency.md` and upstream sources (DTCG
  v2025.10, tailwind-merge guidance, shadcn intro/Tailwind v4, CVA README,
  ESLint rules config, Stylelint home, Chromatic mandatory PR checks,
  Storybook docs).

### Addition 2 — clamp() + zoom accessibility guardrail → `foundations/typography.md`

- Added `### Fluid Scale Guardrails (clamp() & Zoom Accessibility)` subsection
  under Type Scale, with:
  - Decision/Rationale/Rejected box: `rem`/`em` bounds only, max ≤ 2.5× min,
    modest viewport influence, 200% zoom + text-only resize as QA gate.
  - Verification table: all 8 current tokens pass the 2.5× rule (ratios
    1.05×–1.13×).
  - Reinforced rule: 8-size scale is a token vocabulary, not a per-screen menu;
    the ≤4-sizes-per-screen rule stands.
- Cited `research/web-typography-systems.md` and upstream sources (web.dev
  fluid-type 2025-12-16, W3C SC 1.4.4, Utopia clamp()).

### Addition 3 — INP budget + streaming/perf rules → `foundations/motion.md`

- Added `## Responsiveness & Performance Budget` section after Implementation
  Notes, with five subsections:
  - **INP Budget:** ≤ 200 ms explicit target and regression gate.
    Decision/Rationale/Rejected box + implementation priorities (main thread,
    task splitting, layout thrashing, DOM size).
  - **Streaming Text: Yield-Between-Chunks Rule:** Batch chunks, yield,
    no sync reflow after write; tie to existing FloatingScrollLayout /
    `useDeferredValue` / `useTransition` patterns.
    Decision/Rationale/Rejected box.
  - **`content-visibility` for Inactive Shells & Long Transcripts:**
    `content-visibility: hidden` for inactive shells, `auto` for scrollable
    transcripts; reinforces the existing mounted-shell + pause-work contract.
    Decision/Rationale/Rejected box.
  - **View Transitions API: Optional Polish Only:** Skippable,
    reduced-motion-aware, direct-DOM fallback; never a dependency for mode
    switching. Decision/Rationale/Rejected box.
  - **High-Frequency Motion Ceiling:** Animations that fire frequently stay
    under ~150 ms; already reflected in the duration token table.
    Decision/Rationale/Rejected box.
- Cited `research/web-smoothness-motion.md` and upstream sources (web.dev
  RAIL/INP/INP optimization, MDN ViewTransition, React ViewTransition +
  `useDeferredValue`/`useTransition`, CodeMirror viewport model).

### Files changed

| File | Change |
|---|---|
| `design/components.md` | Added Enforcement & Consistency Policy section (override policy, no-orphan-styles, lint contract, visual gate, story coverage contract) |
| `design/foundations/typography.md` | Added Fluid Scale Guardrails subsection with clamp()/WCAG 1.4.4 verification table |
| `design/foundations/motion.md` | Added Responsiveness & Performance Budget section (INP budget, yield-between-chunks, content-visibility, View Transitions, high-frequency ceiling) |
