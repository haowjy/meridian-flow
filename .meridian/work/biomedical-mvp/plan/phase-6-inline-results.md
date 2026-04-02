# Phase 6: Inline Result Rendering (v2)

**Round 3** — Depends on Phase 4 (event type definitions) and Phase 5 (frontend infrastructure).

## Scope

Build the result block renderers for Python execution output: PythonDetail (tool detail), PythonOutputBlock, PlotlyBlock, ImageBlock, DataFrameBlock, MeshRefBlock, and ResultRow. All in `frontend-v2/`.

## Intent

When the agent runs Python code, the researcher sees streaming stdout in the tool detail and rich results (charts, tables, images) prominently in the chat flow. This phase builds those visual components.

## Files to Create

- `frontend-v2/src/features/activity-stream/PythonDetail.tsx` — ToolDetail for execute_python
- `frontend-v2/src/features/activity-stream/items/ResultRow.tsx` — Result block dispatcher
- `frontend-v2/src/features/inline-results/PlotlyBlock.tsx` + `.stories.tsx`
- `frontend-v2/src/features/inline-results/ImageBlock.tsx` + `.stories.tsx`
- `frontend-v2/src/features/inline-results/DataFrameBlock.tsx` + `.stories.tsx`
- `frontend-v2/src/features/inline-results/MeshRefBlock.tsx` + `.stories.tsx`
- `frontend-v2/src/features/inline-results/PythonOutputBlock.tsx` + `.stories.tsx`
- `frontend-v2/src/features/inline-results/index.ts`
- `frontend-v2/src/features/inline-results/examples/mock-data.ts` — Shared mock data for stories
- `frontend-v2/src/features/activity-stream/examples/python-execution.ts` — Streaming scenario
- `frontend-v2/src/index.css` additions — `.meridian-table-wrapper` styles

## Files to Modify

- `frontend-v2/src/features/activity-stream/ToolDetail.tsx` — Route "python" category to PythonDetail
- `frontend-v2/src/features/activity-stream/ActivityBlock.tsx` — Render ResultRow items outside card (if Phase 5 only stubbed this)
- `frontend-v2/package.json` — Add react-plotly.js, plotly.js-dist-min

## Dependencies

- Requires: Phase 4 (event type definitions for TypeScript alignment)
- Requires: Phase 5 (reducer extensions, ResultItem type, workspace store for MeshRefBlock)
- Independent of: Phase 2, 3 (can mock all data for Storybook)
- Produces: MeshRefBlock used by Phase 8 (3D Viewer triggers)

## New Dependencies (npm)

```bash
cd frontend-v2
pnpm add react-plotly.js plotly.js-dist-min
```

## Key Implementation Details

1. **Plotly lazy loading**: Use `React.lazy(() => import("react-plotly.js"))` to keep initial bundle small
2. **PythonOutput collapsing**: Auto-collapse when >20 lines, show last 20 with expand toggle
3. **DataFrameBlock**: DOMPurify sanitization with strict allowlist (table tags only)
4. **MeshRefBlock**: Calls `useWorkspaceStore.showViewer(meshId)` to switch right panel
5. **ResultRow**: Renders outside ActivityBlock card — always visible

## Patterns to Follow

- Component: `frontend-v2/src/features/activity-stream/BashDetail.tsx` — existing ToolDetail pattern
- Stories: `frontend-v2/src/features/activity-stream/ActivityBlock.stories.tsx` — streaming scenarios
- Mocks: `frontend-v2/src/features/activity-stream/examples/factories.ts` — mock factories
- Icons: `@phosphor-icons/react`
- UI primitives: `@/components/ui/dialog`, `@/components/ui/badge`

## Design Docs

- [Inline Results](../../design/frontend/inline-results.md)
- [Activity Stream Extensions](../../design/frontend/activity-stream-extensions.md)

## Verification Criteria

- [ ] `pnpm run build` passes
- [ ] `pnpm run lint` passes
- [ ] PythonDetail renders code preview + streaming output + result summary
- [ ] PythonOutputBlock renders with stderr highlighting and auto-collapse
- [ ] PlotlyBlock renders interactive chart (lazy loaded)
- [ ] ImageBlock renders base64 PNG with click-to-expand dialog
- [ ] DataFrameBlock renders sanitized table with sticky headers and scroll
- [ ] MeshRefBlock shows metadata and "View 3D" button
- [ ] ResultRow dispatches to correct renderer by resultType
- [ ] Storybook stories exist for each component
- [ ] Python execution streaming scenario works in ActivityBlock.stories.tsx

## Agent Staffing

- **Implementer**: `frontend-coder` (React components with some complexity in Plotly lazy loading)
- **Reviewer**: 1x reviewer with security focus (DOMPurify sanitization, dangerouslySetInnerHTML)
- **Verifier**: `verifier` (build + lint)
