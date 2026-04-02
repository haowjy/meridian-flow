# Phase 7: Display Result Renderers

**Round 2** — Requires Phase 5 (DisplayResultItem type).

## Scope

Implement the display result block renderers: PlotlyBlock, ImageBlock, DataFrameBlock, MeshRefBlock. Replace the stub DisplayResultRow from Phase 5 with real routing to these components.

## Intent

Display results need to render as interactive, always-visible blocks in the chat. This phase builds each renderer component with Storybook stories and wires them into DisplayResultRow.

## Files to Create

- `frontend-v2/src/features/inline-results/PlotlyBlock.tsx`
- `frontend-v2/src/features/inline-results/PlotlyBlock.stories.tsx`
- `frontend-v2/src/features/inline-results/ImageBlock.tsx`
- `frontend-v2/src/features/inline-results/ImageBlock.stories.tsx`
- `frontend-v2/src/features/inline-results/DataFrameBlock.tsx`
- `frontend-v2/src/features/inline-results/DataFrameBlock.stories.tsx`
- `frontend-v2/src/features/inline-results/MeshRefBlock.tsx`
- `frontend-v2/src/features/inline-results/MeshRefBlock.stories.tsx`
- `frontend-v2/src/features/inline-results/types.ts`
- `frontend-v2/src/features/inline-results/examples/mock-data.ts`

## Files to Modify

- `frontend-v2/package.json` — Add `react-plotly.js`, `plotly.js-dist-min`
- `frontend-v2/src/features/activity-stream/items/DisplayResultRow.tsx` — Replace stub with real routing
- `frontend-v2/src/index.css` — Add `.meridian-table-wrapper` styles

## Dependencies

- Requires: Phase 5 (DisplayResultItem, DisplayResultPayload types)
- MeshRefBlock depends on workspace store (Phase 6) for `showViewer` — but can render without it (button disabled)
- Independent of: Backend phases

## Patterns to Follow

- Component: existing shadcn/ui patterns, `cn()` utility
- Stories: co-located `.stories.tsx`, shared mock data
- Lazy loading: `lazy(() => import(...))` for plotly

## Constraints

- PlotlyBlock MUST lazy-load react-plotly.js (~1.2MB)
- DataFrameBlock MUST sanitize HTML with DOMPurify (Decision D8)
- ImageBlock uses click-to-expand dialog
- MeshRefBlock calls `useWorkspaceStore.showViewer()` — null-safe if store not ready
- Each component is self-contained with its own story

## Verification Criteria

- [ ] `pnpm run lint` passes
- [ ] Storybook: PlotlyBlock renders bar chart, scatter plot
- [ ] Storybook: ImageBlock renders base64 PNG, click expands
- [ ] Storybook: DataFrameBlock renders HTML table, sanitized
- [ ] Storybook: MeshRefBlock shows vertex/face counts, "View 3D" button
- [ ] DisplayResultRow routes each resultType to correct component

## Agent Staffing

- **Implementer**: `frontend-coder` (v2, Storybook-first)
- **Reviewer**: 1x reviewer (security — DOMPurify config, lazy loading)
- **Verifier**: `verifier`
