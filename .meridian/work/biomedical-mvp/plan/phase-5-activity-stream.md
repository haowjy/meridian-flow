# Phase 5: Frontend Activity Stream Extensions

**Round 1** — Independent. No backend dependency. Frontend phases 6-9 depend on this.

## Scope

Extend the v2 activity stream reducer with `TOOL_OUTPUT` and `DISPLAY_RESULT` event handling. Add `DisplayResultItem` type. Revise ActivityBlock rendering to show display results outside the collapsible card. Add `ToolOutputBlock` component for streaming stdout.

## Intent

The activity stream needs to handle two new event types: tool output (streaming stdout/stderr inside tool details) and display results (charts, tables, images, mesh refs rendered prominently outside the card). This is the foundation for all frontend biomedical rendering.

## Files to Modify

- `frontend-v2/src/features/activity-stream/streaming/events.ts` — Add `TOOL_OUTPUT`, `DISPLAY_RESULT` to StreamEvent union + STREAM_EVENT_TYPES
- `frontend-v2/src/features/activity-stream/streaming/reducer.ts` — Add reducer cases
- `frontend-v2/src/features/activity-stream/types.ts` — Add `ToolOutputLine`, `DisplayResultPayload`, `DisplayResultItem`, extend `ToolItem`, extend `ActivityItem` union
- `frontend-v2/src/features/activity-stream/ActivityBlock.tsx` — Separate displayResults from blockItems, render outside card
- `frontend-v2/src/features/threads/types.ts` — Add `tool_output`, `display_result` to BlockType union
- `frontend-v2/src/features/threads/turn-mapper.ts` — Map persisted `display_result` blocks → DisplayResultItem, `tool_output` blocks → ToolItem.toolOutput

## Files to Create

- `frontend-v2/src/features/activity-stream/items/DisplayResultRow.tsx` — Routes DisplayResultItem to renderers (stub — renders type label for now, real renderers in Phase 7)
- `frontend-v2/src/features/inline-results/ToolOutputBlock.tsx` — Streaming stdout/stderr display
- `frontend-v2/src/features/inline-results/ToolOutputBlock.stories.tsx`
- `frontend-v2/src/features/activity-stream/examples/bash-execution.ts` — Storybook scenario

## Dependencies

- Requires: Nothing (frontend-only, works with mock events)
- Produces: Types and reducer logic that Phases 6, 7, 8 consume

## Patterns to Follow

- Event types: `frontend-v2/src/features/activity-stream/streaming/events.ts` — existing discriminated union
- Reducer: `frontend-v2/src/features/activity-stream/streaming/reducer.ts` — existing switch cases
- Types: `frontend-v2/src/features/activity-stream/types.ts` — existing ActivityItem union
- Turn mapper: `frontend-v2/src/features/threads/turn-mapper.ts` — existing block→item mapping
- Component: `frontend-v2/src/features/activity-stream/items/ContentRow.tsx` — item rendering pattern

## Constraints

- DisplayResultRow is a STUB in this phase — just renders `<div>{item.data.resultType}</div>`. Real renderers (PlotlyBlock, ImageBlock, etc.) are Phase 7.
- Do NOT add zustand stores (that's Phase 6)
- Do NOT add new dependencies (react-plotly.js etc. — that's Phase 7)
- TOOL_OUTPUT must transition tool status to "executing" on first arrival (see activity-stream.md)
- Turn-mapper must handle both streaming (events) and persisted (blocks) reconstruction paths

## Verification Criteria

- [ ] `pnpm run lint` passes
- [ ] Storybook: bash execution scenario renders ActivityBlock with collapsible card
- [ ] Storybook: display results appear outside the card
- [ ] Storybook: ToolOutputBlock shows stdout lines, stderr in red
- [ ] Storybook: ToolOutputBlock auto-collapses at 20+ lines
- [ ] Reducer: TOOL_OUTPUT appends to ToolItem.toolOutput
- [ ] Reducer: DISPLAY_RESULT creates DisplayResultItem in items array
- [ ] Turn-mapper: display_result blocks → DisplayResultItem on reload

## Agent Staffing

- **Implementer**: `frontend-coder` (v2 TypeScript, Storybook-first)
- **Reviewer**: 1x reviewer (correctness — event ordering, reducer state transitions)
- **Verifier**: `verifier` (lint + type check)
