# Frontend v2

Ground-up rebuild of the Meridian frontend. Storybook-first, UI-first, data-last.

## Tech Stack

- **Framework**: Vite 8 + React 19 + TypeScript
- **Styling**: Tailwind CSS v4
- **UI Components**: shadcn/ui (Radix primitives + CVA + tailwind-merge)
- **Icons**: Phosphor Icons (@phosphor-icons/react)
- **Fonts**: Geist (UI), iA Writer Quattro (editor), Geist Mono (code)
- **Toasts**: sonner
- **Storybook**: Storybook 10 (Vite builder)
- **Editor**: CodeMirror 6 (Phase 3, not yet installed)

## Development Commands

```bash
pnpm run dev          # Vite dev server
pnpm run build        # Production build
pnpm run lint         # ESLint
pnpm run storybook    # Storybook at http://localhost:6006
pnpm run build-storybook  # Static Storybook build
```

## Build Order

UI-first, bottom-up. Each phase verified in Storybook before moving on.

| Phase | Focus | Status |
|---|---|---|
| 1 | Foundation (Vite + Tailwind + shadcn + Storybook) | done |
| 2 | Atoms (buttons, badges, inputs, icons, typography) | done |
| 3 | Editor (CM6 live preview from scratch) | not started |
| 4 | Molecules (toolbars, cards, panels, popovers, menus) | not started |
| 5 | Features (thread messages, proposal UI, review toolbar) | not started |
| 6 | Layouts (Converse shell, Studio shell, mode switching) | not started |
| 7 | Data integration (copy stores/API/sync from frontend/) | not started |
| 8 | Routes (TanStack Router, URL sync, auth) | not started |

## Storybook Workflow

1. Build components in isolation with stories
2. Exercise all variants and edge cases
3. Verify visually before integrating into layouts
4. Use the theme toggle (light/dark) in the Storybook toolbar

## Directory Structure

```
frontend-v2/
  .storybook/         -- Storybook config
  src/
    components/
      ui/             -- shadcn/ui primitives + stories
    editor/           -- CM6 live preview (Phase 3)
    layouts/          -- Converse, Studio shells (Phase 6)
    features/         -- Thread, document, review components (Phase 5)
    lib/              -- Utilities (cn(), mock helpers, etc.)
```

## Design System

### Brand Tokens (src/index.css)

- Light mode: Paper background (`#F6F2EA`), near-black text (`#1F1A12`)
- Dark mode: Espresso background (`#1C1917`), warm cream text (`#F0EBE3`)
- Accent: Jade-Teal with two tokens: `accent-fill` (for icons/borders/fills) and `accent-text` (darker, WCAG AA compliant for text)
- Semantic: `success` (green), `warning` (amber), `destructive` (red)
- Fluid typography via `clamp()` — no fixed breakpoint jumps
- 8pt grid spacing system

### Theme System

- `ThemeProvider` in `src/components/theme-provider.tsx`
- Supports light/dark/system with localStorage persistence
- System preference detection via `useSyncExternalStore`
- `ThemeToggle` component in `src/components/ui/theme-toggle.tsx`
- Storybook toolbar toggle works independently

### Atoms (src/components/ui/)

All atoms have co-located `.stories.tsx` files:

| Component | Primitive | Notes |
|-----------|-----------|-------|
| Button | @radix-ui/react-slot | Loading state, icon slots, all variants/sizes |
| Badge | native div + CVA | success/warning/destructive semantic variants |
| Input | native input | Label, error, helper text, 44px touch target |
| Textarea | native textarea | Auto-grow, character count |
| Select | @radix-ui/react-select | Groups, separators, Phosphor icons |
| Dialog | @radix-ui/react-dialog | Viewport-aware (bottom sheet on small screens) |
| Tooltip | @radix-ui/react-tooltip | All placements, focus + hover trigger |
| DropdownMenu | @radix-ui/react-dropdown-menu | Sub-menus, checkbox/radio items, shortcuts |
| Toast | sonner | Success/error/warning/info, actions, stacking |
| Switch | @radix-ui/react-switch | Optional label, settings pattern |
| Checkbox | @radix-ui/react-checkbox | Indeterminate state, label |
| Separator | @radix-ui/react-separator | Horizontal/vertical |
| Label | @radix-ui/react-label | Used internally by other components |

### Adding shadcn Components

```bash
npx shadcn@latest add <component-name>
```

Components land in `src/components/ui/`. Add a `.stories.tsx` file alongside each.

## Dependencies

Bare minimum installed now. Add as needed per phase:

| Phase 3 | `@codemirror/*`, `@lezer/markdown`, `y-codemirror.next` |
| Phase 6 | `react-resizable-panels`, `framer-motion` |
| Phase 7 | `zustand`, `dexie`, `@supabase/supabase-js`, `yjs` |
| Phase 8 | `@tanstack/react-router` |

## Relationship to `frontend/`

`frontend-v2/` is a parallel rebuild. The current `frontend/` remains the production app until v2 is ready. Phase 7 copies stores, API client, and sync services from `frontend/src/core/`.

## Spec Docs

- `_docs/plans/frontend-workspace-modes/spec/` -- workspace modes specs
- `_docs/plans/collab-data-model-v2/future/editor-strategy.md` -- why CM6, editor decisions
