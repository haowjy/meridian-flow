# Custom Diff View Implementation Guide

## What We're Building

A custom diff view for AI suggestions with **unified undo/redo**. The editor displays a merged document with PUA (Private Use Area) Unicode markers, allowing accept/reject operations to work seamlessly with Cmd+Z.

**Key feature: Accept/reject are CM6 transactions**, which means they're automatically undoable.

## Architecture: Merged Display Document

```
┌─────────────────────────────────────────────────────────────┐
│  STORAGE (Database) - Always clean markdown                 │
│  content:    "She felt sad. The rain fell."                │
│  ai_version: "A heavy melancholia. The rain continued."    │
└─────────────────────────────────────────────────────────────┘
                        │
                        │ buildMergedDocument()
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  EDITOR DOCUMENT - Contains PUA markers                     │
│  "\uE000She felt sad.\uE001\uE002A heavy melancholia.\uE003 │
│   The rain \uE000fell\uE001\uE002continued\uE003."          │
│                                                             │
│  Decorations: hide markers, style del/ins regions          │
│  Display: "~~She felt sad.~~ A heavy melancholia. ..."     │
└─────────────────────────────────────────────────────────────┘
                        │
                        │ parseMergedDocument() (on save)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  STORAGE (Database) - Still clean markdown                  │
│  content:    (updated)                                      │
│  ai_version: (updated)                                      │
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** Markers only exist in the frontend editor. Storage and API always see clean markdown.

## PUA Marker Specification

```typescript
// Unicode Private Use Area markers (U+E000-U+E003)
export const MARKERS = {
  DEL_START: '\uE000',  // Start of deletion (original text)
  DEL_END:   '\uE001',  // End of deletion
  INS_START: '\uE002',  // Start of insertion (AI text)
  INS_END:   '\uE003',  // End of insertion
} as const

// Example merged document:
// "\uE000She felt sad.\uE001\uE002A heavy melancholia.\uE003 The rain..."
//  └── deletion ────────────┘ └── insertion ─────────────┘
```

**Why PUA Unicode:**
- Zero collision risk - users never type these characters
- No escaping needed - unlike text markers like `[[DEL:]]`
- CM6 history tracks them - they're document content
- We can reliably hide them via CM6 decorations (don’t rely on font rendering)
- Copy/paste will include markers unless we sanitize (see edit-filter rules)

## Data Flow

```
┌─────────────┐    doc_edit tool     ┌─────────────┐
│   content   │    (str_replace)     │  aiVersion  │
│  (baseline) │ ◄──────────────────► │   (draft)   │
└─────────────┘                      └─────────────┘
       │                                    │
       └────────────┬───────────────────────┘
                    ▼
         ┌───────────────────────┐
         │   diff-match-patch    │  ← Diff + semantic cleanup (existing library)
         └───────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │  buildMergedDocument  │  ← Insert PUA markers (NEW)
         └───────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │   Editor Document     │  ← Merged doc with markers
         └───────────────────────┘
```

**On save:**
```
┌───────────────────────┐
│   Editor Document     │
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│  parseMergedDocument  │  ← Extract content/aiVersion
└───────────┬───────────┘
            ▼
┌─────────────┐    ┌─────────────┐
│   content   │    │  aiVersion  │  ← Clean markdown to API
└─────────────┘    └─────────────┘
```

## Core Invariants (Keep Correctness Obvious)

- **Markers are structure, not content.** Users never see or directly edit the marker characters (`\uE000-\uE003`).
- **Only system transactions** may add/remove marker ranges (accept/reject, refresh from server). Those must bypass filters (`filter: false`).
- **Server refresh is not undoable.** Refresh/hydration must not enter CM6 history (`addToHistory: false`).
- **No “re-diff” on every keystroke.** The merged document is the source of truth during editing; we only rebuild it when `aiVersion` changes from the server.
  - We still scan the merged doc for hunks (`extractHunks`) for decorations/navigation. That’s O(n) marker scanning, not diffing `content` vs `aiVersion`.

## “Dirty” and Server Updates (Don’t Edit Underneath The User)

**Dirty** means: the *active* editor has unsaved edits (`hasUserEdit === true`, i.e. debounce pending / in-flight).

When a new server snapshot arrives (load/refresh/SSE/doc_edit):

- If **not dirty**: refresh the merged document in place (no history).
- If **dirty**: do **not** update the editor. Stash it as `pendingAiVersion` and show a small “AI updated — Refresh” action.

### Refresh Strategy (Cursor-Friendly)

When applying a refresh (only when not dirty):

1) Build: `newMerged = buildMergedDocument(content, aiVersion)`
2) Apply as CM6 changes with `addToHistory: false` and `filter: false`.

For better cursor stability, prefer an **incremental patch** (oldMerged → newMerged) over a full replace. CM6 will map the existing selection through the `changes` automatically.

## Single Review View (No Modes)

There is only one editable view: the merged document with inline diff styling.

Editing rules:
- Green regions (insertions) → editable, changes the AI text
- Red regions (deletions) → read-only, cannot modify original
- Outside hunks → editable, changes merged doc directly

## Accept/Reject Operations

**Accept hunk** = CM6 transaction:
```
Before: "...\uE000old text\uE001\uE002new text\uE003..."
After:  "...new text..."
```
→ Removes deletion + markers, keeps insertion content
→ Recorded in CM6 history → Cmd+Z works!

**Reject hunk** = CM6 transaction:
```
Before: "...\uE000old text\uE001\uE002new text\uE003..."
After:  "...old text..."
```
→ Removes insertion + markers, keeps deletion content
→ Recorded in CM6 history → Cmd+Z works!

**Accept All:**
```
// Replace all marker pairs with their insertion content
merged.replace(/\uE000[^]*?\uE001\uE002([^]*?)\uE003/g, '$1')
```

**Reject All:**
```
// Replace all marker pairs with their deletion content
merged.replace(/\uE000([^]*?)\uE001\uE002[^]*?\uE003/g, '$1')
```

## UI Preview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Document: Chapter 12                                           [✕ Close AI] │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  The rain fell in sheets, drumming against the roof.                         │
│  ~~She felt sad.~~ A heavy melancholia settled in her chest.                 │
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
| 0.1 | `00-core.md` | PATCH tri-state `ai_version` + atomic save contract |
| 1 | `01-foundation.md` | Types, buildMergedDocument, parseMergedDocument |
| 2 | `02-decorations.md` | ViewPlugin to hide markers and style regions |
| 3 | `03-edit-handling.md` | Edit filter to block DEL region edits |
| 4 | `04-state-sync.md` | Save logic, parse on save |
| 5 | `05-ui-components.md` | Navigator pill, hunk action buttons |
| 6 | `06-integration.md` | Wire everything together in EditorPanel |
| 7 | `07-cleanup-and-clipboard.md` | Clipboard sanitization + save-time safety |

## Key Files You'll Create/Modify

### New Files (Frontend)
```
frontend/src/
├── features/documents/utils/
│   └── mergedDocument.ts            ← buildMergedDocument, parseMergedDocument
└── core/editor/codemirror/diffView/
    ├── index.ts                     ← Extension entry point
    ├── plugin.ts                    ← ViewPlugin for decorations
    ├── editFilter.ts                ← Block edits in DEL regions
    ├── keymap.ts                    ← Keyboard shortcuts
    ├── transactions.ts              ← Accept/reject transaction helpers
    └── HunkActionWidget.ts          ← Inline action buttons widget
```

### Modified Files (Frontend)
```
frontend/src/
├── core/
│   ├── stores/useEditorStore.ts     ← Hunk navigation state
│   └── services/documentSyncService.ts ← Parse merged doc on save
└── features/documents/
    ├── hooks/useAIDiff.ts           ← Compute diff hunks
    └── components/
        ├── EditorPanel.tsx          ← Main integration
        ├── AIToolbar.tsx            ← AI suggestions toolbar
        └── AIHunkNavigator.tsx      ← Navigation pill
```

### Backend (Small Update)
The merged document is purely a frontend concern, but we do update the backend so `PATCH /api/documents/{id}` can accept `ai_version` alongside `content` (single request save). Storage remains clean `content` + `ai_version` (no markers).

## Tri-State Semantics for aiVersion

Per project rule "empty string is valid data", `aiVersion` uses **tri-state semantics**:

| Value | Meaning | JSON sent |
|-------|---------|-----------|
| `undefined` | Don't change | Field omitted |
| `null` | Clear (reject all/close AI) | `null` |
| `""` (empty string) | AI suggests empty doc | `""` |
| `"text..."` | AI suggestion | `"text..."` |

**Go implementation note:** for `PATCH` semantics you must distinguish `ai_version` **absent vs null**. Pointer fields can’t do that with `encoding/json`; use a value-type wrapper that tracks presence during unmarshal (see `04-state-sync.md` Step 4.0).

**Important:** When parsing merged document:
- If no markers remain → `aiVersion = null` (AI session complete)
- If only INS markers remain → normal `aiVersion` string

## Prerequisites

Before starting, make sure you understand:
1. CodeMirror 6 basics (EditorView, EditorState, extensions)
2. Compartment pattern for dynamic reconfiguration
3. ViewPlugin pattern (see `frontend/src/core/editor/codemirror/livePreview/plugin.ts`)
4. Zustand store pattern (see `frontend/src/core/stores/useEditorStore.ts`)
5. The existing sync system (see `frontend/CLAUDE.md`)

## Getting Started

Start with `01-foundation.md` →
