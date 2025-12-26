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
- Very low collision risk in normal typing (we still strip markers from inputs defensively)
- No escaping needed - unlike text markers like `[[DEL:]]`
- CM6 history tracks them - they're document content
- We can reliably hide them via CM6 decorations (don’t rely on font rendering)
- Copy/paste will include markers unless we sanitize (see edit-filter rules)

## Why Not CodeMirror Merge View (`@codemirror/merge`)

We intentionally **do not** use CodeMirror’s merge view because Meridian’s AI review mode has a non-standard requirement:

> **Edits in unchanged text (outside a diff chunk) must update both `content` and `aiVersion`.**

Merge view treats the “original” document as a **baseline to compare against**, not a co-edited sibling. Supporting “shared edits” in merge view would require custom bidirectional syncing and careful undo coupling (and tends to be line/chunk-coarse).

The PUA merged-document approach makes this requirement trivial and correct:

| Where user edits | Allowed? | Affects on save | Why |
|---|---|---|---|
| Outside hunks (no markers) | ✅ | `content` **and** `aiVersion` | Shared text exists once in the merged doc, so both projections include it |
| INS region (between `INS_START`/`INS_END`) | ✅ | `aiVersion` only | `parseMergedDocument()` drops INS content when producing `content` |
| DEL region (between `DEL_START`/`DEL_END`) | ❌ | n/a | Original text is read-only; edits would corrupt structure/meaning |

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

## Concurrency: Prevent Stomping Unseen AI Updates

AI can update `aiVersion` while the user is reviewing/editing. To prevent a client save from overwriting a newer `aiVersion` it hasn't seen yet, we use a simple compare-and-swap token:

- Persist `ai_version_rev` (integer) alongside `ai_version`.
- Any time `ai_version` changes (AI tool writes, user clears/sets via PATCH), increment `ai_version_rev`.
- When the client PATCH includes `ai_version`, it must also include `ai_version_base_rev` (the `ai_version_rev` it last saw).
- If `ai_version_base_rev` != current `ai_version_rev`, return `409 Conflict` and do **not** apply the `ai_version` change.

This is **not** a 3rd copy of the document; it’s just a revision counter to avoid last-writer-wins on `ai_version`.

## Core Invariants (Keep Correctness Obvious)

- **Markers are structure, not content.** Users never see or directly edit the marker characters (`\uE000-\uE003`).
- **Only system transactions** may add/remove marker ranges (accept/reject, refresh from server). Those must bypass filters (`filter: false`).
- **Server refresh is not undoable.** Refresh/hydration must not enter CM6 history (`addToHistory: false`).
- **No “re-diff” on every keystroke.** The merged document is the source of truth during editing; we only rebuild it when `aiVersion` changes from the server.
  - We still scan the merged doc for hunks (`extractHunks`) for decorations/navigation. That’s O(n) marker scanning, not diffing `content` vs `aiVersion`.

## "Dirty" and Server Updates (Don't Edit Underneath The User)

**Dirty** means: the *active* editor has unsaved edits (`hasUserEdit === true`, i.e. debounce pending / in-flight).

When a new server snapshot arrives (load/refresh/SSE/doc_edit):

- If **not dirty**: refresh the merged document in place (no history).
- If **dirty**: do **not** update the editor. Stash it as `pendingAiVersion` and show a small "AI updated — Refresh" action.
  - If a save attempts to PATCH `ai_version` and the server returns `409 Conflict` (`ai_version_rev` mismatch), treat it the same way: stash the latest server snapshot and require explicit refresh.

### Server-Sent Events (SSE) for Document Updates

AI processes (like `doc_edit` tool calls from background agents) may update `ai_version` outside of the foreground chat context. To handle this:

- **Backend** broadcasts document updates via SSE (`GET /api/documents/{id}/events`)
- **Frontend** subscribes to document events and triggers the refresh flow when `ai_version_rev` changes

This is preferred over chat-based notifications because it handles background AI processing scenarios where the user isn't actively watching the chat.

See `06-integration.md` Step 6.0.2 for implementation details.

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

## Editor UX Rules in Diff Mode (Writer-first)

Because the editor document is a *merged* representation (not “clean markdown”), some existing editor subsystems must change behavior while diff mode is active (i.e. when markers exist):

- **Live preview**: disabled while diff mode is active. Rendering the merged doc would show both deleted + inserted text and produce confusing output.
- **Formatting commands (bold/italic/heading/etc.)**: allowed only insofar as they modify editable regions (INS + outside hunks). If a formatting command touches a DEL region, the change is blocked (and should show a small, non-disruptive “Can’t edit deleted text” message).
- **Word count**: computed from `parseMergedDocument(localMerged).content` (the baseline projection), not from the raw merged doc.
- **Search/find**: normal find/search works on visible text; markers are hidden and should not affect search UX.

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
| 0.1 | `00-backend-contract.md` | PATCH tri-state `ai_version` + CAS (`ai_version_rev`) |
| 0.2 | `00-editor-hydration.md` | History-safe hydration + live preview toggle |
| 1 | `01-foundation.md` | Types, buildMergedDocument, parseMergedDocument |
| 2 | `02-decorations.md` | ViewPlugin to hide markers and style regions |
| 3 | `03-edit-handling.md` | Edit filter to block DEL region edits |
| 3a | `03a-blocked-edit-feedback.md` | Toast notification when edits blocked |
| 3.1 | `07-cleanup-and-clipboard.md` | Implement clipboard sanitization early (Step 7.2) |
| 4 | `04-state-sync.md` | Save logic, parse on save, 409 conflict handling |
| 4a | `04a-conflict-error-handling.md` | Error utilities for 409 Conflict responses |
| 5 | `05-ui-components.md` | Navigator pill, hunk action buttons (UI only) |
| 6 | `06-integration.md` | Wire everything together in EditorPanel |
| 6a | `06a-document-polling.md` | Detect background AI updates (polling v1) |
| 7 | `07-cleanup-and-clipboard.md` | Save-time safety + corruption repair |

## Key Files You'll Create/Modify

### New Files (Frontend)
```
frontend/src/
├── features/documents/
│   ├── utils/
│   │   ├── mergedDocument.ts       ← buildMergedDocument, parseMergedDocument
│   │   └── saveMergedDocument.ts   ← Save helper for merged docs
│   └── hooks/
│       └── useDocumentPolling.ts   ← Poll for background AI updates
├── core/
│   ├── editor/codemirror/diffView/
│   │   ├── index.ts                ← Extension entry point
│   │   ├── plugin.ts               ← ViewPlugin for decorations
│   │   ├── editFilter.ts           ← Block edits in DEL regions
│   │   ├── blockedEditEffect.ts    ← Effect for blocked edit notification
│   │   ├── blockedEditListener.ts  ← Listener for blocked edit effect
│   │   ├── clipboard.ts            ← Strip markers on copy/paste
│   │   ├── keymap.ts               ← Keyboard shortcuts
│   │   ├── transactions.ts         ← Accept/reject transaction helpers
│   │   ├── focus.ts                ← Focused hunk highlighting state
│   │   └── HunkActionWidget.ts     ← Inline action buttons widget
│   └── lib/
│       └── errorUtils.ts           ← Error utilities (409 conflict handling)
└── types/
    └── errors.ts                   ← Conflict response types
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

**Concurrency note:** whenever `ai_version` is included in a PATCH, also send `ai_version_base_rev` to avoid overwriting unseen server updates.

**Go implementation note:** for `PATCH` semantics you must distinguish `ai_version` **absent vs null**. Pointer fields can’t do that with `encoding/json`; use a value-type wrapper that tracks presence during unmarshal (see `00-backend-contract.md`).

**Important (when to PATCH `ai_version`):**
- Most saves should be **content-only** (omit `ai_version` entirely).
- When the editor contains markers (AI review active), save should include `ai_version` (string) + `ai_version_base_rev`.
- When the editor has **no markers** but the server still has `ai_version` (AI session open), save should include `ai_version: null` **once** to close the AI session.
  - This supports “last hunk resolved via per-hunk ✓/✕” while still keeping undo/redo sane: if the user undoes and markers come back, the next save can re-open AI by PATCHing `ai_version` again.

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
