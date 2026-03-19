# Frontend v2 Rebuild

Ground-up rebuild of the Meridian frontend. Feature-based architecture, Storybook-first, UI-first, data-last.

## Feature Map

Each feature has its own directory with design specs that double as implementation blueprints.

### Core (the app has to work)

| Feature | Dir | Status | Notes |
|---------|-----|--------|-------|
| Design system + Storybook | `design-system/` | in progress | Atoms, theme, shared components |
| Auth | `auth/` | not started | Sign in, free tier guest mode, session |
| Explorer | `explorer/` | not started | File tree, CRUD, drag-and-drop reorder, word count |
| Editor | `editor/` | not started | CM6 live preview, 4 decoration layers, focus mode |
| Collab | `collab/` | not started | Hunks, suggestions panel, comments, review toolbar |
| Threads | `threads/` | not started | Chat, streaming, tool calls |
| Layouts + Rails | `layouts/` | not started | Converse, Studio, Agents shells. Shared editor/chat. |
| Tabs | `tabs/` | not started | Multi-tab documents, hybrid mount (LRU), Studio-primary |
| Local-first | `local-first/` | not started | Optimistic updates, assume success, reconcile later |
| Command palette | `command-palette/` | not started | Keyboard shortcuts, Cmd+K navigation |
| Notifications | `notifications/` | not started | Toasts, error surfacing for failed optimistic updates |
| Connectivity | `connectivity/` | not started | WebSocket reconnect, offline queue, status indicator |
| Search | `search/` | not started | Cross-document, within-project |
| Settings | `settings/` | not started | Theme, editor prefs, per-project settings |
| Mobile | `mobile/` | not started | Responsive design, touch-friendly, tablet support |

### Platform (differentiating features)

| Feature | Dir | Status | Notes |
|---------|-----|--------|-------|
| Agents + Skills | `agents-skills/` | not started | Meridian FS through Claude, skill management |
| Import / Export | `import-export/` | not started | Zip archives, future publish workflow |
| Onboarding | `onboarding/` | not started | Free tier flow, how-to-use |

### Future

| Feature | Dir | Status | Notes |
|---------|-----|--------|-------|
| Landing page | `landing-page/` | not started | Public marketing page, plan last |

## Architecture Decisions

- **Feature-based directory structure** -- each feature owns its components, hooks, stores, and types
- **Shared atoms in `design-system/`** -- buttons, inputs, badges, typography. No feature-specific components here.
- **Hybrid tab mounting** -- keep 2-3 recent CM6 instances alive (LRU), destroy the rest. Y.Docs stay alive regardless.
- **Optimistic local-first** -- UI updates immediately, reconciles with server async. Failures surface via notifications.
- **Mobile-aware** -- not a separate app, but responsive design and touch targets from the start.

## Existing Code (frontend-v2/)

Phase 1 (foundation) is done. Phase 2 (atoms) is in progress -- button + badge built.

- Vite 8 + React 19 + TypeScript
- Tailwind CSS v4 + shadcn/ui (base-nova style, Base UI primitives)
- Storybook 10
- `@base-ui/react` (not Radix)
