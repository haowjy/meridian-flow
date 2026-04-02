# Phase 5: Frontend Infrastructure (v2)

**Round 1** — No backend dependency. Can start immediately, in parallel with Phases 1 and 2.

## Scope

Set up the foundational frontend infrastructure in `frontend-v2/` that all subsequent frontend phases need: workspace layout, zustand stores, activity stream event extensions, API client, and tool category additions.

## Intent

`frontend-v2/` has the UI components and streaming infrastructure but lacks layouts, stores, and routing. This phase builds the skeleton so Phases 6-8 can focus on feature components.

## Files to Create

- `frontend-v2/src/features/workspace/WorkspaceLayout.tsx` — PanelGroup with two panels
- `frontend-v2/src/features/workspace/ChatPanel.tsx` — Left panel wrapper
- `frontend-v2/src/features/workspace/ContentPanel.tsx` — Right panel content switcher
- `frontend-v2/src/features/workspace/ContentToolbar.tsx` — Tab bar for right panel
- `frontend-v2/src/features/workspace/EmptyState.tsx` — Empty right panel
- `frontend-v2/src/features/workspace/WorkspaceLayout.stories.tsx` — Storybook story
- `frontend-v2/src/features/workspace/index.ts`
- `frontend-v2/src/stores/workspace-store.ts` — Panel state, active project/thread
- `frontend-v2/src/stores/dataset-store.ts` — Upload progress state
- `frontend-v2/src/stores/viewer-store.ts` — Mesh data, structure visibility
- `frontend-v2/src/lib/api.ts` — Fetch wrapper for backend API
- `frontend-v2/src/features/inline-results/types.ts` — Result type definitions

## Files to Modify

- `frontend-v2/src/features/activity-stream/streaming/events.ts` — Add PYTHON_OUTPUT, PYTHON_RESULT
- `frontend-v2/src/features/activity-stream/streaming/reducer.ts` — Handle new events (note: PYTHON_OUTPUT transitions tool to "executing" — see activity-stream-extensions.md)
- `frontend-v2/src/features/activity-stream/types.ts` — Add ResultItem, PythonOutputLine, PythonResultPayload
- `frontend-v2/src/features/activity-stream/tool-utils.ts` — Add "python" tool category
- `frontend-v2/src/features/activity-stream/ToolDetail.tsx` — Route to PythonDetail (stub)
- `frontend-v2/src/features/activity-stream/ActivityBlock.tsx` — Promote ResultItems outside card
- `frontend-v2/src/features/threads/types.ts` — Add `python_output` and `python_result` to BlockType
- `frontend-v2/src/features/threads/turn-mapper.ts` — Map persisted python blocks into ActivityItem types on reload
- `frontend-v2/package.json` — Add react-resizable-panels, zustand, @tanstack/react-router

## Dependencies

- Requires: Nothing (no backend dependency)
- Independent of: All backend phases
- Produces: Layout shell, stores, and extended reducer used by Phases 6-8

## New Dependencies (npm)

```bash
cd frontend-v2
pnpm add react-resizable-panels zustand @tanstack/react-router
```

## Key Implementation Details

1. **Workspace layout**: `react-resizable-panels` PanelGroup with 45/55 default split, min 30% each
2. **Store pattern**: zustand with actions on the store (not external action creators)
3. **Reducer extensions**: Add PYTHON_OUTPUT and PYTHON_RESULT to the StreamEvent union and reduceStreamEvent
4. **ResultItem promotion**: Modify ActivityBlock to render ResultItems outside the collapsible Card
5. **Tool category**: Add "python" category to tool-utils.ts with appropriate icon, label, and summary

## Patterns to Follow

- Store: Follow zustand patterns from `frontend/src/core/stores/` for the general shape
- Reducer: Follow the existing case pattern in `reducer.ts` — immutable updates, `updateItemById`
- Layout: Follow `FloatingScrollLayout` pattern for the chat panel wrapper
- Components: shadcn/ui, Tailwind v4, Phosphor icons, co-located stories

## Design Docs

- [Layout](../../design/frontend/layout.md)
- [State Management](../../design/frontend/state.md)
- [Activity Stream Extensions](../../design/frontend/activity-stream-extensions.md)

## Verification Criteria

- [ ] `pnpm run build` passes
- [ ] `pnpm run lint` passes
- [ ] WorkspaceLayout renders in Storybook with resizable panels
- [ ] ContentPanel switches between content types via workspace store
- [ ] Activity stream reducer handles PYTHON_OUTPUT and PYTHON_RESULT events
- [ ] ResultItem renders outside the collapsible ActivityBlock card
- [ ] "python" tool category correctly identifies `execute_python`
- [ ] Zustand stores have correct TypeScript types

## Agent Staffing

- **Implementer**: `frontend-coder` (layout + store + reducer — moderate complexity)
- **Reviewer**: 1x reviewer with SOLID focus (store boundaries, reducer purity)
- **Verifier**: `verifier` (build + lint)
