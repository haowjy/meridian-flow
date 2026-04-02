# Phase 9: Data Analyst Agent Profile

**Round 3** — Depends on Phase 3 (execute_python tool must be registered). Can run in parallel with Phases 6 and 7.

## Scope

Create the `.agents/agents/data-analyst.md` persona file with biomedical domain knowledge. No code changes — this is a file-only persona that the existing PersonaCatalog discovers automatically.

## Intent

The researcher selects "Data Analyst" in the agent picker and gets an AI that knows uCT imaging, bone morphometry, statistical analysis, and the execute_python tool's result helpers.

## Files to Create

- `.agents/agents/data-analyst.md` — Full persona file with frontmatter + system prompt

## Files to Modify

None. The `PersonaCatalog` automatically discovers new files in `.agents/agents/`.

## Content

The file is specified in the design doc at `design/agent/data-analyst-agent.md`. Key elements:

**Frontmatter**:
- model: opus
- tools: [execute_python, str_replace_based_edit_tool, doc_search]
- temperature: 0.3
- max_turns: 50

**System prompt sections**:
- Capabilities overview (Python packages available)
- Working methodology (show work, checkpoint before proceeding)
- Code practices (result_helper functions)
- Domain knowledge: DICOM loading, bone segmentation, orientation, geometric indices, landmarks
- Statistical methods: ANOVA, Dunnett's, ROC, Bland-Altman, ICC
- Publication figure standards

## Dependencies

- Requires: Phase 3 (execute_python tool must be registered for the agent to use it)
- Independent of: All frontend phases

## Verification Criteria

- [ ] File parses successfully (valid YAML frontmatter + markdown body)
- [ ] `PersonaCatalog.ResolvePersona(ctx, projectID, "data-analyst")` succeeds
- [ ] Agent appears in `ListUserPersonas()` output
- [ ] Tool filter correctly limits to execute_python, str_replace_based_edit_tool, doc_search
- [ ] System prompt includes all domain knowledge sections

## Agent Staffing

- **Implementer**: `coder` (single file creation, but domain knowledge must be accurate)
- **Reviewer**: 1x reviewer (validate domain knowledge accuracy against requirements and existing notebook code)
