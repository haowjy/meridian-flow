# Phase 5: Frontend Inline Result Rendering

**Round 3** — Depends on Phase 4 (needs event type definitions to handle).

## Scope

Add SSE event handlers for `PYTHON_OUTPUT` and `PYTHON_RESULT`, plus block renderers for code output, Plotly charts, matplotlib images, and DataFrame tables. This is the chat-side rendering — the 3D viewer is Phase 7.

## Intent

When the agent runs Python code, the researcher sees streaming stdout in the chat, followed by rich results (charts, tables, images). This phase makes those visible.

## Files to Create

- `frontend/src/features/threads/hooks/sse/eventHandlers/pythonOutputHandler.ts`
- `frontend/src/features/threads/hooks/sse/eventHandlers/pythonResultHandler.ts`
- `frontend/src/features/threads/components/blocks/PythonOutputBlock.tsx`
- `frontend/src/features/threads/components/blocks/PlotlyBlock.tsx`
- `frontend/src/features/threads/components/blocks/ImageBlock.tsx`
- `frontend/src/features/threads/components/blocks/DataFrameBlock.tsx`
- `frontend/src/features/threads/components/blocks/MeshRefBlock.tsx`
- `frontend/src/features/threads/components/blocks/PythonResultRenderer.tsx`

## Files to Modify

- `frontend/src/features/threads/hooks/sse/SSEEventDispatcher.ts` — Register new event handlers
- `frontend/src/features/threads/components/` — Activity block rendering to dispatch to new block types
- `frontend/src/features/threads/types.ts` — Add new block type constants
- `frontend/src/features/threads/stores/` — Thread store additions for Python output buffering

## Dependencies

- Requires: Phase 4 (event type definitions must exist for frontend type alignment)
- Independent of: Phase 3 (can mock Python events for Storybook development)
- Produces: Block renderers used by Phase 7 (MeshRefBlock triggers 3D viewer)

## Key Implementation Details

1. **Plotly lazy loading**: Import `react-plotly.js` via `React.lazy()` to keep initial bundle small
2. **PythonOutput collapsing**: Auto-collapse output blocks >20 lines with expand toggle
3. **DataFrameBlock**: Uses `dangerouslySetInnerHTML` for pre-rendered HTML tables; style via `.meridian-table-wrapper` CSS
4. **Multiple results per turn**: A single execute_python call can produce multiple results (e.g., a chart + a table). All render in sequence.

## New Dependencies (npm)

```bash
pnpm add react-plotly.js plotly.js-dist-min
```

## Patterns to Follow

- Event handlers: `frontend/src/features/threads/hooks/sse/eventHandlers/` (existing handler pattern)
- Block rendering: `frontend/src/features/threads/components/` (TurnRow → ActivityBlock → block dispatching)
- Existing block type handling in the activity stream components
- Design system: shadcn/ui components, Tailwind v4 classes, Phosphor icons

## Verification Criteria

- [ ] `pnpm run build` passes
- [ ] `pnpm run lint` passes
- [ ] PythonOutputBlock renders streaming text with stderr highlighting
- [ ] PlotlyBlock renders interactive chart from JSON spec
- [ ] ImageBlock renders base64 PNG with click-to-expand
- [ ] DataFrameBlock renders styled table with sticky headers
- [ ] MeshRefBlock shows metadata and "View 3D" button
- [ ] Storybook stories exist for each new block component

## Agent Staffing

- **Implementer**: `frontend-coder` (React components, event handlers)
- **Reviewer**: 1x reviewer with frontend focus (accessibility, responsive design)
- **Verifier**: `verifier` (build + lint)
