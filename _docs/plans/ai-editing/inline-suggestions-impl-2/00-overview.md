# Custom Diff View Implementation Guide

## What We're Building

A custom word-level diff view for AI suggestions that replaces `@codemirror/merge`. This shows inline changes (red strikethrough for deletions, green underline for insertions) and lets users accept/reject individual changes.

## Data Flow

```
┌─────────────┐    doc_edit tool     ┌─────────────┐
│   content   │    (str_replace)     │  aiVersion  │
│  (baseline) │ ◄──────────────────► │   (draft)   │
└─────────────┘                      └─────────────┘
       │                                    │
       └────────────┬───────────────────────┘
                    ▼
              Word-level diff
                    │
                    ▼
            ┌───────────────┐
            │  Diff Hunks   │  ← Display in Changes mode
            │  (deletions,  │  ← Accept/reject operations
            │   insertions) │
            └───────────────┘
```

**Key points:**
- `content` = user's original document (baseline)
- `aiVersion` = AI-modified version (draft)
- LLM uses `doc_edit` tool to patch `aiVersion`
- Diff view compares both to show word-level changes
- User can accept/reject hunks or edit directly

## Three Editing Modes

| Mode | Shows | Editable | What edits affect |
|------|-------|----------|-------------------|
| Original | `content` | Yes | `content` only |
| AI Draft | `aiVersion` | Yes | `aiVersion` only |
| Changes | `aiVersion` + ghost deletions | Partial | See below |

**Changes mode editing:**
- Green regions (AI insertions) → edits `aiVersion`
- Red regions (deletions) → read-only
- Outside hunks → edits BOTH documents

## UI Preview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Document: Chapter 12                                           [✕ Close AI] │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐                     │
│  │   Original    [Changes]    AI Draft                 │  ← Mode tabs        │
│  └─────────────────────────────────────────────────────┘                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  The rain fell in sheets, drumming against the roof.                         │
│  S̶h̶e̶ ̶f̶e̶l̶t̶ ̶s̶a̶d̶.̶  A heavy melancholia settled in her chest.               │
│                                                        ┌─────────┐          │
│                                                        │ ✓   ✕   │ ← Hover  │
│                                                        └─────────┘          │
├──────────────────────────────────────────────────────────────────────────────┤
│              ┌─────────────────────────────────────────────────────┐         │
│              │  ↑  Change 1/3  ↓  │  Reject All   Accept All       │ ← Pill  │
│              └─────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Phases

| Phase | Document | What You'll Build |
|-------|----------|-------------------|
| 1 | `01-foundation.md` | Install jsdiff, create useWordDiff hook |
| 2 | `02-decorations.md` | CodeMirror ViewPlugin for diff styling |
| 3 | `03-edit-handling.md` | Mode-aware edit filtering, position mapping |
| 4 | `04-state-sync.md` | Store extensions, atomic sync operations |
| 5 | `05-ui-components.md` | Navigator pill, hunk action buttons |
| 6 | `06-integration.md` | Wire everything together, test |

## Key Files You'll Create/Modify

### New Files
```
frontend/src/
├── features/documents/
│   ├── hooks/useWordDiff.ts              ← Word-level diff computation
│   └── components/AIHunkNavigator.tsx    ← Floating navigation pill
└── core/editor/codemirror/diffView/
    ├── index.ts                          ← Extension entry point
    ├── types.ts                          ← TypeScript interfaces
    ├── plugin.ts                         ← ViewPlugin for decorations
    ├── DeletionWidget.ts                 ← Widget for ghost deletions
    ├── HunkActionWidget.ts               ← Per-hunk ✓/✕ buttons
    ├── editFilter.ts                     ← Mode-aware transaction filter
    ├── positionMapping.ts                ← Offset table utilities
    └── keymap.ts                         ← Keyboard shortcuts
```

### Modified Files
```
frontend/
├── package.json                          ← Add 'diff' dependency
├── src/globals.css                       ← Add diff styling
├── src/core/stores/useEditorStore.ts     ← Hunk operations, locks
├── src/core/lib/api.ts                   ← Add updateBoth() method
├── src/core/services/documentSyncService.ts ← Add saveBoth() method
└── src/features/documents/components/
    ├── EditorPanel.tsx                   ← Wire up diff view
    └── AIToolbar.tsx                     ← Mode switching
```

### Deleted Files
```
frontend/src/features/documents/hooks/useAIDiff.ts  ← Replaced by useWordDiff
```

## Prerequisites

Before starting, make sure you understand:
1. CodeMirror 6 basics (EditorView, EditorState, extensions)
2. ViewPlugin pattern (see `frontend/src/core/editor/codemirror/livePreview/plugin.ts`)
3. Zustand store pattern (see `frontend/src/core/stores/useEditorStore.ts`)
4. The existing sync system (see `frontend/CLAUDE.md`)

## Getting Started

Start with `01-foundation.md` →
