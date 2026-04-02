# Phase 6: Workspace Layout + Zustand Stores

**Round 2** — Requires Phase 5 (activity stream types).

## Scope

Build the workspace layout shell (react-resizable-panels), zustand stores (workspace, viewer, dataset), API client, and auth integration. This is the v2 data integration layer for biomedical.

## Intent

The biomedical workspace needs a two-panel layout (chat left, content right), state management for panel switching and mesh data, and an API client for dataset endpoints. This phase builds the infrastructure that viewer, dataset upload, and 3D viewer phases consume.

## Files to Create

- `frontend-v2/src/features/workspace/WorkspaceLayout.tsx`
- `frontend-v2/src/features/workspace/ChatPanel.tsx`
- `frontend-v2/src/features/workspace/ContentPanel.tsx`
- `frontend-v2/src/features/workspace/ContentToolbar.tsx`
- `frontend-v2/src/features/workspace/EmptyState.tsx`
- `frontend-v2/src/features/workspace/WorkspaceLayout.stories.tsx`
- `frontend-v2/src/features/workspace/index.ts`
- `frontend-v2/src/stores/workspace-store.ts`
- `frontend-v2/src/stores/viewer-store.ts`
- `frontend-v2/src/stores/dataset-store.ts`
- `frontend-v2/src/lib/api.ts` — API client
- `frontend-v2/src/lib/auth.ts` — Auth token provider

## Files to Modify

- `frontend-v2/package.json` — Add `react-resizable-panels`, `zustand`
- `frontend-v2/src/features/threads/streaming/ThreadWsProvider.tsx` — Wire binary frame handler to viewer store

## Dependencies

- Requires: Phase 5 (DisplayResultItem type for viewer store to reference)
- Produces: Layout shell, stores, API client used by Phases 7, 8, 9

## Patterns to Follow

- Zustand: standard `create<State>((set, get) => ...)` pattern per design/frontend/state.md
- Layout: react-resizable-panels with Panel/PanelGroup/PanelResizeHandle
- API client: fetch wrapper with auth header per design/frontend/state.md
- WS binary: existing `onBinaryMessage` in WsClient config

## Constraints

- ContentPanel renders stub content for viewer/datasets/editor (real components in later phases)
- Viewer store's `receiveBinaryMesh` must merge with `pendingMeshLabels` (race handling)
- Auth: dev mode uses `VITE_AUTH_TOKEN` env var, production deferred
- Desktop-only: min 1024px viewport check
- `BONE_COLORS` defined once in `features/viewer-3d/constants.ts`, imported by viewer store

## Verification Criteria

- [ ] `pnpm run lint` passes
- [ ] Storybook: WorkspaceLayout renders with resizable panels
- [ ] Storybook: ContentToolbar shows tabs, switches active content
- [ ] Store: workspace store switches content views
- [ ] Store: viewer store merges pending labels with binary mesh data
- [ ] API client: apiFetch adds auth header

## Agent Staffing

- **Implementer**: `frontend-coder` (v2, zustand, layout)
- **Reviewer**: 1x reviewer (state management — race handling, store contracts)
- **Verifier**: `verifier`
