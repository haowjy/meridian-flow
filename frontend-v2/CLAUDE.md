# Frontend v2

Ground-up rebuild of the Meridian frontend. Storybook-first, UI-first, data-last.

## Tech Stack

- **Framework**: Vite 8 + React 19 + TypeScript
- **Styling**: Tailwind CSS v4
- **UI Components**: shadcn/ui (Base UI + CVA + tailwind-merge)
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
| 2 | Atoms (buttons, badges, inputs, icons, typography) | in progress |
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

## Adding shadcn Components

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
