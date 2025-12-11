---
detail: standard
audience: developer
---

# AI Inline Suggestions (Merge View)

## 1. Overview

### What

Inline AI suggestions using CodeMirror’s **`@codemirror/merge` unifiedMergeView**:

- Single editable **AI draft** (the “result” document)
- **Original** user content used as a read‑only baseline
- **Changes view** shows a unified inline diff with per‑chunk Accept/Reject
- Optional **Draft‑only** and **Original‑only** views for focused editing/reading

### Why

Writers need granular control over AI suggestions while keeping implementation simple and robust:

- Review each change in context
- Accept good suggestions and reject bad ones, chunk by chunk
- See exactly what will change before committing to the main document
- Rely on CodeMirror’s built‑in diff, position tracking, and undo/redo instead of a custom projection layer

### Why `@codemirror/merge`

| Feature                 | Custom Projection Plan       | `@codemirror/merge`            |
|-------------------------|-----------------------------|---------------------------------|
| Inline diff display     | Custom decorations           | ✅ Built‑in unified view        |
| Accept/reject per chunk | Custom widgets + routing     | ✅ `acceptChunk()` / `rejectChunk()` |
| Position tracking       | Manual projection + mapping  | ✅ Automatic                    |
| Undo/redo semantics     | Complex (dual sources)       | ✅ Native history support       |
| LOC / complexity        | ~200+ lines + tests          | ~20 lines of config             |

**Key insight:** `unifiedMergeView` treats the **primary editor document as the editable result** and the **original as a read‑only baseline**. This matches “edit the AI draft while seeing how it differs from my original” and avoids a hand‑rolled projection system.

---

## 2. Modes & UX

We keep a simple mental model:

- One editable **AI draft** (`draft`) – what the user is actively editing during AI review
- One read‑only **Original** (`baseline`) – the user’s content at the start of the AI session

In addition to inline diffs, we use a **floating hunk navigator pill** (Cursor‑style) for fast navigation between suggestions and documents.

### Modes (Header Area)

Mode switching is part of the **AI session UI**, not normal editing:

- The AI header strip (with mode buttons + summary) only renders when `aiVersion` exists.
- In normal editing (no AI draft), the header shows only the standard document header; there is no mode toggle.

When active, mode switching lives in the existing sticky header area (just under the document header), not in the floating pill.

Contents of the AI header strip:

- Centered segmented control: `[Original]   [Changes]   [AI Draft]`
- No per-document or cross-document counts or actions here; this strip is purely for **view mode switching** during an AI session.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Document Header                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  AI Session Mode Strip                                               │
│  ┌──────────────────────────────┐                                    │
│  │  Original   Changes   Draft  │                                    │
│  └──────────────────────────────┘                                    │
└──────────────────────────────────────────────────────────────────────┘
```

| Mode        | Shows                       | Editable | Source of truth for undo/redo |
|-------------|-----------------------------|----------|--------------------------------|
| Original    | Baseline user content       | ❌ No    | N/A                            |
| Changes     | Unified diff (baseline vs draft) | ✅ Yes (draft only) | ✅ Draft history             |
| AI Draft    | Draft only (no diff)        | ✅ Yes   | ✅ Draft history               |

Notes:

- Only the **draft** is editable while an AI review is active.
- The **Original** view is purely for reading (baseline snapshot).
- Undo/redo always operates on the **draft** document, regardless of view.

### Floating Hunk Navigator (Pill)

A pair of small floating pills appears inside the editor content area when there are AI suggestions:

```
              ┌───────────────────────────────┐   ┌──────────────────────┐
              │  ↑   change   ↓  Reject Accept│   │ ⟨ 1 / N documents ⟩ │
              └───────────────────────────────┘   └──────────────────────┘
                        ⬆ bottom‑center of editor
```

A pill row is **navigation and document-level actions**, not mode switching:

- Anchored to the **bottom‑center of the editor pane**, floating above content.
- Left pill (hunks):
  - Previous / next hunk controls (`↑` / `↓`), wired to merge navigation (e.g., `goToNextChunk` / `goToPreviousChunk`).
  - Primary actions for the current document: **Reject All** / **Accept All** (affect all hunks in this document; language explicitly matches suggestion semantics).
  - (Future) optional `current / total` hunk label based on the frontend diff for the active document.
- Right pill (documents):
  - Previous / next document with suggestions: `⟨ 1 / N documents ⟩` where `N` comes from documents with `aiVersion != null` and `aiPendingSuggestions = TRUE`.
  - Navigating updates the active document and keeps the current mode (Original/Changes/AI Draft).
- Clicking hunk prev/next:
  - Scrolls the inline diff to the corresponding chunk.
  - Moves the editor selection/cursor into that chunk.
- Clicking document prev/next:
  - Switches to the previous/next document that has an AI draft.
  - Loads that document in Changes/AI Draft view (preserving current mode).
- In Changes mode, the pill mirrors keyboard shortcuts:
  - `Alt‑N` → next hunk
  - `Alt‑P` → previous hunk
  - `Cmd/Ctrl+Enter` → Accept current hunk
  - `Cmd/Ctrl+Backspace` → Reject current hunk

Scroll affordance:

- When the pill is visible, the editor’s scroll container adds an extra **bottom spacer** (e.g., `max(120px, 25vh)`).
- This allows users to scroll past the last line so the pill can sit over empty space instead of covering the final paragraph.

The pill is purely a **navigation and status layer**; the primary diff experience stays inline via `unifiedMergeView`.

#### Empty-document state: "Review next document"

When the current document has **no remaining hunks** (no visible changes in the unified diff), but other documents still have `aiPendingSuggestions = TRUE`:

- The left hunk pill hides (no per-hunk navigation or Accept/Reject All needed).
- A simplified right pill is shown:

```
              ┌───────────────────────────────┐
              │  Review next document   ▸    │
              └───────────────────────────────┘
                        ⬆ bottom‑center of editor
```

- Clicking the pill jumps directly to the next document with pending suggestions.
- The same “Review next document” CTA can also appear in the document sidebar (explorer) whenever **any** document has pending suggestions, even if the current document has none.

---

## 3. User Workflow

### High‑Level Flow

```mermaid
sequenceDiagram
    participant User
    participant Editor
    participant AI
    participant Server

    User->>AI: "Make this more concise"
    AI->>Server: Produces AI draft (ai_version)
    Server-->>Editor: Document { content (baseline), aiVersion (draft) }

    Editor->>User: Show toolbar with modes (Original / Changes / AI Draft)

    alt User selects "Changes" mode
        Editor->>User: Show unified inline diff (baseline vs draft)
    else User selects "AI Draft" mode
        Editor->>User: Show AI draft only (editable)
    else User selects "Original" mode
        Editor->>User: Show baseline only (read‑only)
    end

    alt Accept chunk
        User->>Editor: acceptChunk()
        Editor->>Editor: Apply change in draft
    else Reject chunk
        User->>Editor: rejectChunk()
        Editor->>Editor: Revert change in draft
    end

    alt Accept All
        User->>Editor: Click "Accept All"
        Editor->>Server: Save draft as new content, clear aiVersion
        Editor->>User: Document content updated, AI session resolved
    else Reject All
        User->>Editor: Click "Reject All"
        Editor->>Server: Discard draft (delete aiVersion)
        Editor->>User: Original content restored, AI session resolved
    end
```

### States

1. **No AI draft** – Normal editing, `Document.content` is editable; no toolbar.
2. **AI draft present** – Toolbar visible, `Document.aiVersion` is editable, `content` is baseline.
3. **Partial acceptance** – Some chunks accepted/reverted in draft.
4. **Session resolved** – Either:
   - Accept All → `content` updated from draft, `aiVersion` cleared, or
   - Reject All → `aiVersion` cleared, baseline remains.

---

## 4. Technical Design

### 4.1 Data Model

For a document with suggestions:

- `content` (baseline) – user’s original content when the AI edit was requested.
- `aiVersion` (draft) – AI‑produced version that the user is reviewing and editing.
- `aiPendingSuggestions` (boolean, optional) – `true` if there are any pending suggestions for this document, `false` otherwise (for cross‑doc nav / badges).

Rules:

- When `aiVersion` is **present**:
  - Editing happens on `aiVersion` (draft) via:
    - AI Draft mode (plain editor)
    - Changes mode (unified diff vs `content`)
  - `content` is treated as **read‑only baseline** in the UI.
- When `aiVersion` is **absent**:
  - Normal editing; `content` is editable and auto‑saved as today.

Backend invariants:

- After any write that touches `content` or `aiVersion`:
  - If `content == aiVersion` → clear AI session:
    - Set `aiVersion = NULL`
    - Set `aiPendingSuggestions = FALSE` (if column exists)
  - Else:
    - Leave `aiVersion` as non‑null (AI session active).
- `aiPendingSuggestions` (if stored):
  - Is maintained on the backend whenever `aiVersion` is set or cleared (no frontend writes).
  - Is used only for “documents with suggestions” navigation and tree badges, not for core correctness.

### 4.2 CodeMirror Configuration

Base extensions for the markdown editor stay the same (keymaps, language, theme, etc.).

#### Draft‑only mode (AI Draft)

```ts
const draftExtensions = [
  ...baseExtensions,
  // no merge view
]
```

Editor doc = `aiVersion` (falling back to `content` if `aiVersion` is null).

#### Changes mode (Unified diff)

Use `unifiedMergeView` from `@codemirror/merge`:

```ts
import { unifiedMergeView, acceptChunk, rejectChunk, goToNextChunk, goToPreviousChunk } from '@codemirror/merge'

const changesExtensions = (baseline: string) => [
  ...baseExtensions,
  unifiedMergeView({
    original: baseline,
    highlightChanges: true,        // Strikethrough + highlights
    mergeControls: true,           // Per-chunk ✓/✗ buttons
    allowInlineDiffs: true,        // Small changes shown inline (6.10.0+)
    gutter: true,                  // Gutter markers for changed lines
    syntaxHighlightDeletions: true,
  }),
]
```

Key behaviors:

- **Editable side** = draft (`aiVersion`).
- **Original side** = `content` (baseline), read‑only.
- `acceptChunk` and `rejectChunk` mutate the draft; undo/redo works on these edits.

### 4.3 Mode Switching & Extensions

`EditorPanel` chooses extensions based on mode and whether an AI draft exists:

- If `!aiVersion` → normal “content” editor (no merge view, no toolbar).
- If `aiVersion` present:
  - Mode `aiDraft` → `draftExtensions`.
  - Mode `changes` → `changesExtensions(content)`.
  - Mode `original` → separate read‑only view (no editing, no history).

Switching modes:

- Does **not** change the underlying draft text.
- Simply reconfigures extensions and which text is rendered.
- **Note:** Mode switching recreates CodeMirror state, so undo history resets. This is an acceptable trade-off for simplicity; users rarely switch modes mid-edit.

### 4.4 Persisting Draft Changes

When in an AI session (`aiVersion` present):

- The editable doc is the **draft string** in React/Zustand state.
- Changes are persisted by:
  - Debounced PATCH to `/api/documents/:id/ai-version` (similar to `saveDocument`).
  - Accept All:
    - `api.documents.update(id, draft)` → update `content`
    - `api.documents.deleteAIVersion(id)` → clear `aiVersion`
  - Reject All:
    - `api.documents.deleteAIVersion(id)` → discard draft

This keeps backend semantics aligned with the current API while shifting editing focus to `aiVersion` during AI review.

---

## 5. Implementation Plan

### Phase 1: Mode State + Toolbar

**Files**

- `frontend/src/core/stores/useEditorStore.ts`
- `frontend/src/features/documents/components/AIToolbar.tsx`

**Changes**

- Add editor mode state:

```ts
export type EditorMode = 'normal' | 'changes' | 'aiDraft'

interface EditorStore {
  editorMode: EditorMode
  setEditorMode: (mode: EditorMode) => void
}
```

- Update `AIToolbar` (or AI mode strip) to:
  - Only render when `aiVersion` is present.
  - Show mode buttons: Original, Changes, AI Draft.

### Phase 2: EditorPanel Wiring

**File**

- `frontend/src/features/documents/components/EditorPanel.tsx`

**Changes**

- Derive:
  - `baseline = activeDocument.content ?? ''`
  - `draft = activeDocument.aiVersion ?? baseline`
- When `aiVersion` exists:
  - Disable normal `content` auto‑save (content is frozen).
  - Use `editorMode` to choose which view to show:
    - Original → read‑only CM with `EditorView.editable.of(false)`, doc = `baseline`.
    - AI Draft → editable CM with `draftExtensions`, doc = `draft`.
    - Changes → editable CM with `changesExtensions(baseline)`, doc = `draft`.
- Wire draft editing to:
  - Local `draft` state.
  - Debounced `api.documents.patchAIVersion(documentId, draft)` call.
- Wire per-chunk accept/reject (Changes mode only):

```ts
// The mergeControls option adds built-in ✓/✗ buttons per chunk.
// For programmatic/keyboard control:
import { acceptChunk, rejectChunk, goToNextChunk, goToPreviousChunk } from '@codemirror/merge'

// Call on editor view to accept/reject chunk at cursor
acceptChunk(editorRef.current.view)
rejectChunk(editorRef.current.view)

// Optional keyboard shortcuts (add to extensions)
keymap.of([
  { key: 'Mod-Enter', run: acceptChunk },
  { key: 'Mod-Backspace', run: rejectChunk },
  { key: 'Alt-n', run: goToNextChunk },
  { key: 'Alt-p', run: goToPreviousChunk },
])
```

### Phase 3: Accept All / Reject All Semantics

Accept All:

- Set editor content to `draft`.
- Call `api.documents.update(documentId, draft)`.
- Call `api.documents.deleteAIVersion(documentId)` and update store with returned doc.

Reject All:

- Call `api.documents.deleteAIVersion(documentId)` to drop the draft.
- Store updates; `content` becomes editable again in normal mode.

### Phase 4: Styling & UX Polish

**Files**

- `frontend/src/globals.css`
- `frontend/src/features/documents/components/AIToolbar.tsx`
 - `frontend/src/features/documents/components/AIHunkNavigator.tsx` (new)

**Changes**

- Ensure unified diff view uses:
  - Red strikethrough for deletions.
  - Green highlights for additions.
- Keep toolbar consistent with existing AI styles (colors, buttons).
- Add floating **AI hunk navigator pill**:
  - Positioned at bottom‑center of the editor pane (absolute within editor container).
  - Semi‑transparent background; hides or fades when no hunks are present.
  - Uses `goToNextChunk` / `goToPreviousChunk` and current hunk index to drive navigation.

---

## 6. Edge Cases

| Case                                | Handling                                               |
|-------------------------------------|--------------------------------------------------------|
| No `aiVersion`                      | No toolbar; normal content editing only                |
| `aiVersion === content`            | No visible chunks; can still show “No changes” state   |
| User types while in Changes view    | Edits apply to draft only; baseline untouched          |
| New AI draft arrives mid‑editing    | Only allowed when no active AI session; otherwise queued/future |
| Discard AI draft (Reject All)       | Deletes `aiVersion`, returns to normal content editing |

---

## 7. Future Enhancements

- **Keyboard shortcuts**: accept/reject chunk, switch modes.
- **Comments**: comment threads anchored to ranges in the draft, visible in Changes view.
- **Per‑chunk metadata**: show which edits were AI vs user refinements.
- **Session history**: multiple AI drafts or “compare to previous AI run”.

---

## 8. References

- CodeMirror merge docs (`@codemirror/merge`, `unifiedMergeView`)
- Google Docs Suggesting Mode UX
