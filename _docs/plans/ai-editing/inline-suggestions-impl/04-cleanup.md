# Phase 4: Cleanup

Remove the old implementation now that the new one is complete.

---

## Step 12: Remove Old Implementation

**Goal:** Delete unused code from the `diff-match-patch` approach.

### Files to Delete

```
frontend/src/features/documents/hooks/useAIDiff.ts
frontend/src/features/documents/components/DiffDisplay.tsx
```

### Files to Update

**`frontend/src/features/documents/components/EditorPanel.tsx`**

Remove:
- Import of `useAIDiff`
- Import of `applyAccept`, `applyReject` from useAIDiff
- Import of `DiffDisplay` (if present)
- Any references to `hunks` from the old hook
- The old `_handleAccept` and `_handleReject` handlers (prefixed with `_`)

**`frontend/package.json`**

Optionally remove `diff-match-patch` if no longer used elsewhere:
```bash
pnpm remove diff-match-patch
pnpm remove @types/diff-match-patch
```

### Verification Checklist

Before deleting, verify:

- [ ] New merge view works in all three modes
- [ ] Accept All / Reject All work correctly
- [ ] Per-chunk accept/reject work (via mergeControls)
- [ ] Keyboard shortcuts work
- [ ] Navigator works
- [ ] No TypeScript errors after removal
- [ ] No runtime errors after removal
- [ ] `pnpm run lint` passes
- [ ] `pnpm run build` succeeds

### Commands

```bash
# Delete old files
rm frontend/src/features/documents/hooks/useAIDiff.ts
rm frontend/src/features/documents/components/DiffDisplay.tsx

# Verify no broken imports
pnpm run lint
pnpm run build

# Optionally remove diff-match-patch
pnpm remove diff-match-patch @types/diff-match-patch
```

---

## Final Verification

### Functional Tests

1. **No AI suggestions**
   - [ ] Normal editor works
   - [ ] Auto-save works
   - [ ] No toolbar/mode switcher visible

2. **With AI suggestions**
   - [ ] Toolbar appears with mode switcher
   - [ ] Changes mode shows diff
   - [ ] AI Draft mode shows plain editor
   - [ ] Original mode shows read-only overlay
   - [ ] Accept All merges content and clears aiVersion
   - [ ] Reject All discards aiVersion

3. **Mode Switching**
   - [ ] Changes ↔ AI Draft preserves undo history
   - [ ] Original → back preserves state

4. **Keyboard Shortcuts**
   - [ ] Alt+N / Alt+P navigate chunks
   - [ ] Cmd+Enter accepts chunk
   - [ ] Cmd+Backspace rejects chunk

5. **Visual**
   - [ ] Light mode looks good
   - [ ] Dark mode looks good
   - [ ] Navigator pill positioned correctly

### Code Quality

- [ ] No unused imports
- [ ] No `// eslint-disable` for unused vars
- [ ] No dead code
- [ ] Types are clean

---

## Migration Complete!

The AI inline suggestions feature now uses `@codemirror/merge` with:

- **Three view modes**: Original, Changes, AI Draft
- **History preservation**: Compartment-based mode switching
- **Keyboard shortcuts**: Navigate and accept/reject chunks
- **Visual polish**: Inline diff with gutter markers
- **Clean architecture**: Logic encapsulated in `useMergeEditor` hook

### Architecture Summary

```
EditorPanel
├── useEditorStore (aiEditorMode)
├── useMergeEditor (Compartment, switchMode)
├── AIToolbar (mode switcher, Accept All, Reject All)
├── AIHunkNavigator (floating pill)
├── OriginalOverlay (read-only view)
└── CodeMirrorEditor
    └── mergeExtensions (changesExtensions, draftExtensions)
```
