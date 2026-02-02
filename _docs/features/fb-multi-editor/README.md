# Multi-Editor Architecture (Content Adapter Pattern)

**Status**: ✅ Foundation Complete (Phases 1-3) | 🟡 Editor Components Pending (Phases 4-6)

**Stack**: Frontend + Backend (Backend unchanged for Phase 1-3)

**Feature Owner**: Core Team

---

## Overview

Multi-editor support enables Meridian to handle different file types (markdown, LaTeX, plaintext, images, DOCX, etc.) with appropriate editors while maintaining the AI integration system.

## Problem

The existing AI integration uses Unicode PUA (Private Use Area) markers embedded in markdown strings. This approach is fundamentally incompatible with non-text formats:

- **Images**: Can't embed PUA markers in binary data
- **DOCX**: Markers would corrupt XML/JSON structure
- **Excalidraw**: Can't mark up object properties

## Solution

**Content Adapter Pattern**: Transform between storage ↔ editor formats, allowing each editor type to define its own AI integration strategy.

```typescript
interface ContentAdapter<TStorage, TEditor> {
  editorType: EditorType
  toEditor(storage: TStorage, aiVersion?: TStorage | null): TEditor
  toStorage(editor: TEditor): { content: TStorage; aiVersion: TStorage | null }
  hasAISuggestions(editor: TEditor): boolean
  capabilities: EditorCapabilities
}
```

## Implementation Status

### ✅ Phase 1-3: Adapter Foundation (Complete)

**What's Done**:
- Adapter interface and registry
- Markdown, LaTeX, and plaintext adapters (all text-based, reuse PUA markers)
- Generalized hooks (`useDocumentContent`, `useDocumentSync`)
- Updated `EditorPanel` to pass extension parameter
- All linting passing, fully backwards compatible

**Files Created**:
- `frontend/src/core/editor/adapters/types.ts` - Adapter interfaces
- `frontend/src/core/editor/adapters/markdownAdapter.ts` - Markdown adapter
- `frontend/src/core/editor/adapters/latexAdapter.ts` - LaTeX adapter
- `frontend/src/core/editor/adapters/plaintextAdapter.ts` - Plaintext adapter
- `frontend/src/core/editor/adapters/registry.ts` - Adapter registry

**Files Modified**:
- `frontend/src/core/editor/types/editorRegistry.ts` - Made `BaseEditorRef` generic
- `frontend/src/features/documents/hooks/useDocumentContent.ts` - Adapter-based
- `frontend/src/features/documents/hooks/useDocumentSync.ts` - Adapter-based
- `frontend/src/features/documents/components/EditorPanel.tsx` - Pass extension

### 🟡 Phase 4: LaTeX Editor (Pending)

**Goal**: Prove adapter pattern works end-to-end

**Tasks**:
1. Create `LaTeXEditor.tsx` component (dual-pane: source + preview)
2. Add `@codemirror/lang-stex` for syntax highlighting
3. Add `katex` for math rendering in preview pane
4. Register in `EditorPanel` factory pattern

### 🟡 Phase 5: Image Viewer (Pending)

**Goal**: Support binary files (different AI strategy)

**Backend Changes**:
- Add file upload endpoint
- Add blob storage (S3/CDN)
- Return blob URLs in `DocumentDto`

**Frontend Tasks**:
1. Create `ImageViewer.tsx` component
2. Implement `imageAdapter` (blob URL ↔ editor format)
3. Optional: Annotation overlay for AI suggestions

### 🟡 Phase 6: Factory Pattern in EditorPanel (Pending)

**Goal**: Conditionally render editors based on file type

**Tasks**:
1. Detect `editorType` from `extension`
2. Conditionally render `CodeMirrorEditor` vs `LaTeXEditor` vs `ImageViewer`
3. Conditionally show AI navigator based on `capabilities.supportsAIDiff`

## AI Integration Strategies Per Format

| Editor Type | AI Diff Strategy | Implementation Status |
|-------------|------------------|----------------------|
| **Markdown** | PUA markers (existing) | ✅ Complete (wrapped in adapter) |
| **LaTeX** | PUA markers (same as markdown) | ✅ Adapter ready, editor pending |
| **Plaintext** | PUA markers (same as markdown) | ✅ Adapter ready |
| **Image** | Annotation overlay | 🟡 Adapter designed, not implemented |
| **DOCX** | Side-by-side comparison | 🟡 Design only |
| **Excalidraw** | JSON diff on scene graph | 🟡 Design only |

## Technical Details

### Adapter Registry

```typescript
// Get adapter for editor type
const adapter = getAdapter('markdown')

// Transform storage → editor format
const editorContent = adapter.toEditor(doc.content, doc.aiVersion)

// Transform editor → storage format
const { content, aiVersion } = adapter.toStorage(editorContent)

// Check for AI suggestions
const hasAI = adapter.hasAISuggestions(editorContent)
```

### Editor Capabilities

```typescript
interface EditorCapabilities {
  supportsAIDiff: boolean      // Can show inline AI diff view
  supportsVersioning: boolean  // Can track separate content + aiVersion
  contentFormat: 'string' | 'object' | 'binary'
  editable: boolean            // Can be edited vs read-only
}
```

### Backwards Compatibility

**Markdown documents**: Zero changes
- `markdownAdapter.toEditor()` calls `buildMergedDocument()` (existing)
- `markdownAdapter.toStorage()` calls `parseMergedDocument()` (existing)
- No changes to `mergedDocument.ts`
- Adapter is a **wrapper**, not a rewrite

## Usage

### For Developers

**Adding a new editor type:**

1. Create adapter in `frontend/src/core/editor/adapters/`:
   ```typescript
   export const myAdapter: TypedContentAdapter<'mytype'> = {
     editorType: 'mytype',
     toEditor(content, aiVersion) { /* ... */ },
     toStorage(editorContent) { /* ... */ },
     hasAISuggestions(editorContent) { /* ... */ },
     capabilities: { /* ... */ },
   }
   ```

2. Register in `registry.ts`:
   ```typescript
   const adapters = new Map([
     // ...
     ['mytype', myAdapter],
   ])
   ```

3. Update `EditorType` in `editorRegistry.ts`:
   ```typescript
   export type EditorType = 'markdown' | 'latex' | 'mytype' | ...
   ```

4. Create editor component (e.g., `MyEditor.tsx`)

5. Add to `EditorPanel` factory pattern (Phase 6)

## Testing

**Manual Testing Checklist**:
1. ✅ Open existing markdown document → Loads correctly
2. ✅ Edit markdown → Auto-saves correctly
3. ✅ AI creates suggestions → Shows inline diff view
4. ✅ Accept/reject AI changes → Works identically to before
5. ✅ Navigate away → Flushes pending changes

## Related Documentation

- **Implementation Summary**: `_docs/IMPLEMENTATION_SUMMARY.md`
- **Original Plan**: Plan mode transcript (phases 1-6)
- **AI Integration**: `_docs/technical/llm/` (PUA marker system)
- **Editor Architecture**: `frontend/CLAUDE.md` (CodeMirror conventions)

## Notes

**Why this matters**:
- Writers may want to include LaTeX equations, images, diagrams in their fiction
- AI can suggest edits to images (crop, filter), LaTeX (fix equations), etc.
- Each format needs a different AI integration strategy
- Adapter pattern provides extensibility without breaking existing code

**Flexibility Rating**: **9/10** (was 6/10 before adapters)
