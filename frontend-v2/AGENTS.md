# Frontend v2 — Conventions

Ground-up rebuild of the Meridian frontend. Storybook-first, UI-first,
data-last.

## Prime Directives

1. **Token-first.** Every visual value — color, spacing, radius, duration,
   easing, font size, shadow — comes from a design token. No raw hex, no
   arbitrary Tailwind values outside the whitelist (see Enforcement).
2. **Storybook-first / UI-first / data-last.** Build in isolation with
   stories. Exercise all variants and edge cases. Verify visually before
   integrating into layouts. Data integration is Phase 7.
3. **SOLID.** One file = one purpose. Keep components small, focused,
   composable.
4. **Search before implement.** Before adding a utility, pattern, or
   dependency, search the repo for existing equivalents.
5. **Plan before implement.** Read the relevant AGENTS.md for the seam
   you're working in. Read the design spec section it points to.
6. **Good code is code that is easy to change.** The convention docs at
   each seam are what keep change cheap — follow them.

## Source of Truth

The canonical design spec lives at `_docs/design/` (the
`frontend-v2-design-language` work). Every design decision — tokens,
spacing, motion, layout structure, interaction patterns — is made there.
**AGENTS.md files point to it; they do not re-derive or copy its
decisions.** Duplicated decisions drift and rot.

Spec structure:

| Section | Key docs |
|---|---|
| Foundations | `tokens.md`, `typography.md`, `color.md`, `motion.md`, `elevation.md`, `responsive.md` |
| Components | `components.md` (atom inventory, composites, enforcement policy, mobile composites) |
| Layouts | `overview.md`, `agents.md`, `converse.md`, `studio.md` |
| Interaction | `editor.md`, `navigation.md`, `threads-and-tools.md`, `proposals-review.md` |

## Enforcement & Consistency Policy

The anti-rot core. Summary — canonical detail in
`_docs/design/components.md` §Enforcement & Consistency Policy.

### Override Policy

`className` and `twMerge` are **boundary escape hatches** — for merging
consumer overrides at the component boundary only. Internal composition
uses `twJoin` or plain string concatenation. `twMerge` is called only where
a consumer's `className` prop merges with the component's own defaults.

Every component that exposes style variants **must** use a canonical variant
factory (CVA for atoms, `tailwind-variants` permitted for slot-heavy
composites). The variant map is the single source of truth for supported
styling states.

### No-Orphan-Styles Rule

If a style pattern appears in more than one place, it must graduate into
a token, a CVA variant, or a shared composite. One-off Tailwind strings
in JSX are the primary vector for future refactoring brittleness.

### Lint Contract (CI Gate, `error` Level)

| Rule | Package |
|---|---|
| `no-arbitrary-value` | `eslint-plugin-tailwindcss` |
| `no-custom-classname` | `eslint-plugin-tailwindcss` |
| No raw hex / raw color values | custom ESLint or Stylelint |
| Require `data-slot` on shadcn-derived primitives | custom ESLint |
| Require variant factory for styled components | custom ESLint |

Raw hex/color values are only permitted in `foundations/` token-plumbing
files. Stylelint supplements ESLint for CSS-level conventions.

### Visual Gate (Chromatic)

Chromatic is a **required PR check** gated by branch protection. A PR with
visual diffs cannot merge until reviewed and approved.

### Story Coverage Contract

Every supported component state deserves a Storybook story. Minimum
checklist per component:

- Loading state (Skeleton/spinner)
- Empty state (centered message + icon + action)
- Error state (message + retry, where applicable)
- Interaction states (hover, focus-visible, active, disabled)
- Every supported variant combination

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Vite 8 + React 19 + TypeScript 5.9 |
| Styling | Tailwind CSS v4 with `@theme inline` tokens |
| UI primitives | shadcn/ui new-york (Radix + CVA + tailwind-merge), Ark UI (TreeView) |
| Icons | Phosphor Icons (`@phosphor-icons/react`) |
| Fonts | Geist Variable (UI), iA Writer Quattro (editor), Geist Mono Variable (code) |
| Editor | CodeMirror 6 with custom live-preview decorations |
| Collab | Yjs (CRDT), y-indexeddb, y-protocols, y-codemirror.next (installed, not yet wired) |
| WebSocket | Custom `lib/ws/` (4-lane envelope: control/notify/stream/error) |
| Data | TanStack Query 5, Dexie 4 (IndexedDB) |
| Content | marked, turndown, mermaid, partial-json |
| Toasts | sonner |
| Storybook | Storybook 10 (Vite builder, a11y, docs, Chromatic) |

## Development Commands

```bash
pnpm run dev          # Vite dev server
pnpm run build        # TypeScript check + Vite production build
pnpm run lint         # ESLint
pnpm run storybook    # Storybook at http://localhost:6006
pnpm run build-storybook  # Static Storybook build
```

## Build Order

| Phase | Focus | Status |
|---|---|---|
| 1 | Foundation (Vite + Tailwind + shadcn + Storybook + ThemeProvider) | ✅ done |
| 2 | Atoms (35 shadcn/ui components with co-located stories) | ✅ done |
| 3 | Editor (CM6 live preview, Yjs architecture, SessionPool, IDB, WS transport) | ⚠️ ~80% |
| 4 | Molecules (FloatingScrollLayout built; no standalone toolbar/panel components) | ⚠️ ~30% |
| 5 | Features (activity stream, threads, composer, chat scroll, doc WS provider) | ⚠️ ~70% |
| 6 | Layouts (Converse shell, Studio shell, Agents shell, mode switching) | ❌ not started |
| 7 | Data integration (WS exists; no API client, no zustand stores) | ⚠️ ~30% |
| 8 | Routes (TanStack Router, URL sync, auth) | ❌ not started |

## Seam Index

Each major seam has its own `AGENTS.md` with local invariants and design-spec
pointers. Read the one for your seam before you write code.

| Seam | Path | AGENTS.md | Responsibility |
|---|---|---|---|
| Primitives | `src/components/ui/` | `src/components/ui/AGENTS.md` | shadcn/ui atoms, co-located stories, CVA factories, token consumption |
| Editor | `src/editor/` | `src/editor/AGENTS.md` | CM6 architecture, decoration layers, DocSession/ViewController/SessionPool invariants |
| Layouts | `src/layouts/` | `src/layouts/AGENTS.md` | Mode shells (Agents/Converse/Studio), app shell, responsive grid, pane model |
| Features | `src/features/` | `src/features/AGENTS.md` | Feature-colocation rules, story discipline, streaming-first data models |
| Shared infra | `src/lib/` | `src/lib/AGENTS.md` | `cn()` utility, WS client library, query invalidation, Dexie helpers |

## Cross-Cutting Rules

### File Naming

- Components: `PascalCase.tsx` with co-located `PascalCase.stories.tsx`
- Stories that need helpers/multiple files: move to a `stories/` subdirectory
- Utilities/types: `kebab-case.ts`
- Feature directories: `kebab-case/`

### Where New Things Go

| If it's... | Put it in... |
|---|---|
| A shadcn/ui primitive (added via `npx shadcn@latest add`) | `src/components/ui/` — add `.stories.tsx` alongside |
| A shared composite (Rail, TabBar, PanelResizeHandle, BottomSheet) | `src/components/ui/` — same rules as primitives |
| An editor-specific component | `src/editor/components/` |
| A feature-specific component | `src/features/<feature-name>/` with shared mock factories |
| A layout shell (Agents, Converse, Studio) | `src/layouts/<mode>/` |
| A shared layout primitive (pane wrappers, drawer/sheet adapters) | `src/layouts/shared/` |
| A generic utility or infra library | `src/lib/` |

### The `cn()` Utility

The single class-merge entrypoint: `src/lib/utils.ts`. `cn()` wraps
`clsx` + `tailwind-merge`. All component `className` composition goes
through `cn()`. No direct `clsx` or `twMerge` calls outside this utility.

### Storybook Workflow

1. Build components in isolation with stories
2. Exercise all variants and edge cases
3. Verify visually before integrating into layouts
4. Use the theme toggle (light/dark) in the Storybook toolbar
5. **Modify the component, not the story** — fix the underlying source when
   a story reveals a problem
6. Share mock factories per feature directory; never duplicate mock data
   across stories

## Relationship to `frontend/`

`frontend-v2/` is a parallel rebuild. The current `frontend/` remains the
production app until v2 is ready. Phase 7 copies stores, API client, and
sync services from `frontend/src/core/`.

Key differences from v1:

- Tailwind v4 with `@theme inline` (v1 uses v3)
- Fluid `clamp()` typography (v1 uses fixed breakpoints)
- shadcn/ui new-york component library (v1 uses custom components)
- CM6 with live preview decorations (no shadow DOM)
- Yjs + SessionPool warm-session architecture for collab
- Dual-token accent (`accent-fill` vs `accent-text`) for WCAG AA
- All components have Storybook stories with simulated data

## Design System (Summary)

Full detail in `_docs/design/foundations/`. Brief reference:

| System | Key tokens/rules |
|---|---|
| Color | Paper `#F6F2EA` / Espresso `#1C1917`; dual accent (`accent-fill` ≠ `accent-text`); `accent-text` for all teal text |
| Typography | 8 fluid `clamp()` sizes; Geist (UI) / iA Writer Quattro (prose) / Geist Mono (code); `clamp()` bounds ≤ 2.5× ratio |
| Spacing | 8pt grid, 15 tokens (`spacing-0`–`spacing-24`); semantic padding: `compact` (8px), `default` (12px), `relaxed` (16px) |
| Motion | 5 duration tokens (0–300ms); 4 easing tokens; mode switch is instant (0ms); respect `prefers-reduced-motion` |
| Elevation | 3 levels: `none` (default), `subtle` (1px/3px), `overlay` (4px/12px); border-first philosophy |
| Responsive | Phone (< 600px) / Tablet (600–1199px) / Desktop (≥ 1200px); viewport queries for shell, container queries for pane internals; 44px touch targets |
