# Phase 10: Agent Profile + Integration

**Round 4** — Requires Phase 3 (backend pipeline) + Phase 8 (3D viewer).

## Scope

Create the data-analyst agent profile. Run end-to-end integration test of the full pipeline.

## Files to Create

- `.agents/agents/data-analyst.md` — Agent profile (markdown only)

## Verification Criteria

- [ ] Agent profile loads via PersonaCatalog
- [ ] Tool filtering: bash, str_replace_based_edit_tool, doc_search available
- [ ] E2E: bash tool executes Python in Daytona sandbox
- [ ] E2E: show_plotly() → DISPLAY_RESULT → PlotlyBlock renders
- [ ] E2E: show_mesh() → DISPLAY_RESULT + binary frame → 3D viewer
- [ ] Reload: display results persist from turn blocks
- [ ] Auto-switch: mesh_ref switches content panel to viewer

## Agent Staffing

- **Implementer**: `coder`
- **Tester**: `smoke-tester`
- **Reviewer**: 1x reviewer (design alignment)
