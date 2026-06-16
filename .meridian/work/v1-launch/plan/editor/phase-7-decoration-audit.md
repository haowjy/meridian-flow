# Phase 7: Decoration Audit

## Goal

Audit the final live-preview and review decoration stack for viewport scoping, rebuild guards, and widget equality behavior so the refactor does not regress large-document performance.

## Dependencies

- Phase 1 complete
- Phase 5 complete
- Phase 6 complete

## Parallelism

- `P7.1` and `P7.2` can run in parallel once the final extension stack is stable.
- `P7.3` depends on both.

## Step Summary

| Step | Outcome | Risk | Recommended model |
|---|---|---|---|
| P7.1 | Inline and line-level ViewPlugin audit | Medium | `gpt-5.3-codex` |
| P7.2 | Block/widget audit including proposal-hunk and mermaid paths | Medium | `gpt-5.4` |
| P7.3 | Stress-story verification and cleanup pass | Low | `gpt-5.3-codex` |

### Step P7.1: Audit Inline And Line-level Plugins

**Scope and intent**

Review the inline/line-level decoration plugins for `visibleRanges` scoping, rebuild guards, and unnecessary DOM churn.

**Files to create or modify**

- `frontend-v2/src/editor/decorations/emphasis.ts`
- `frontend-v2/src/editor/decorations/heading.ts`
- `frontend-v2/src/editor/decorations/blockquote.ts`
- `frontend-v2/src/editor/decorations/links.ts`
- `frontend-v2/src/editor/decorations/images.ts`
- `frontend-v2/src/editor/decorations/lists.ts`
- `frontend-v2/src/editor/decorations/horizontal-rule.ts`

**Patterns to follow**

- Follow the checklist in the refactor design doc.
- Prefer cheap early exits on `docChanged`, `viewportChanged`, and syntax-tree changes.

**Constraints and boundaries**

- Do not change user-facing semantics unless the current plugin is provably violating the final design.
- Keep this step focused on audit/fix, not feature expansion.

**Verification criteria**

- No audited plugin scans the full syntax tree outside `visibleRanges` unless the design explicitly requires it.
- Rebuilds are guarded and explainable.
- Existing stories still render identically after the audit.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/decorations/emphasis.ts
-f frontend-v2/src/editor/decorations/heading.ts
-f frontend-v2/src/editor/decorations/blockquote.ts
-f frontend-v2/src/editor/decorations/links.ts
-f frontend-v2/src/editor/decorations/images.ts
-f frontend-v2/src/editor/decorations/horizontal-rule.ts
```

### Step P7.2: Audit Block And Widget Paths

**Scope and intent**

Validate the layout-affecting decorations and widgets: fenced code, mermaid, proposal hunks, and any other block-level replace decorations. This is where poor `eq()` behavior or full-field rebuilds will hurt most.

**Files to create or modify**

- `frontend-v2/src/editor/decorations/block-decorations.ts`
- `frontend-v2/src/editor/decorations/fenced-code-widget.ts`
- `frontend-v2/src/editor/decorations/mermaid-widget.ts`
- `frontend-v2/src/editor/decorations/atomic-ranges.ts`
- `frontend-v2/src/editor/decorations/proposal-hunks.ts`

**Patterns to follow**

- Keep layout-affecting decorations in state fields where CM6 requires them.
- Ensure widgets implement `eq()` and `updateDOM()` when meaningful.

**Constraints and boundaries**

- Do not redesign widget visuals here.
- Any major proposal-hunk rendering redesign belongs back in Phase 5, not in the audit pass.

**Verification criteria**

- All widgets have a justified `eq()` strategy.
- No unconditional full rebuild remains in block/proposal decoration code.
- Cursor navigation around atomic widgets still works.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/decorations/block-decorations.ts
-f frontend-v2/src/editor/decorations/fenced-code-widget.ts
-f frontend-v2/src/editor/decorations/mermaid-widget.ts
-f frontend-v2/src/editor/decorations/atomic-ranges.ts
-f frontend-v2/src/editor/decorations/proposal-hunks.ts
```

### Step P7.3: Add Stress Stories And Final Regression Checks

**Scope and intent**

Leave behind verification artifacts that make the audit repeatable: long-document Storybook scenarios, regression notes, and a final lint/build-storybook gate.

**Files to create or modify**

- `frontend-v2/src/editor/stories/LivePreview.stories.tsx`
- `frontend-v2/src/editor/stories/EditorPerformance.stories.tsx`
- `frontend-v2/src/editor/stories/helpers/mockContent.ts`

**Patterns to follow**

- Reuse the existing long-form mock content strategy.
- Keep the stress stories focused on editor rendering, not transport noise.

**Constraints and boundaries**

- Storybook is the primary regression surface here, but browser/manual verification is still warranted for mermaid and large-widget layouts.

**Verification criteria**

- `pnpm run lint` passes.
- `pnpm run build-storybook` passes.
- Stress stories render long documents without obvious full-document rebuild artifacts when typing or scrolling.
- Final regression note lists any known residual hotspots instead of silently accepting them.

**Context files (`-f`)**

```text
-f frontend-v2/src/editor/stories/LivePreview.stories.tsx
-f frontend-v2/src/editor/stories/helpers/mockContent.ts
-f frontend-v2/src/editor/decorations/block-decorations.ts
-f frontend-v2/src/editor/decorations/mermaid-widget.ts
```
