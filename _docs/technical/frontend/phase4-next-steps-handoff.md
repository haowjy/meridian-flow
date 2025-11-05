---
detail: standard
audience: developer
status: active
---

# Phase 4 Next Steps – Handoff

## Current State

**Completed:**
- ✅ Phase 4.1: 3-panel workspace layout shell
- ✅ Phase 4.2: Panel state management + coordination helpers
- ✅ UIStore fully implemented with persistence
- ✅ Clean accessibility (aria-* attributes, tooltips)
- ✅ Build passing with zero TypeScript errors

**Ready to use:**
- Panel coordination helpers in `frontend/src/core/lib/panelHelpers.ts`
- API endpoints for documents in `frontend/src/core/lib/api.ts`
- Type definitions in `frontend/src/features/documents/types/`
- Store skeletons in `frontend/src/core/stores/useTreeStore.ts` and `useEditorStore.ts`

---

## What Needs to Be Built

### Document Tree UI (Phase 4.8-4.9)

**Purpose:** Right panel document browser with folder hierarchy.

**Components needed:**
- DocumentPanel – wrapper that switches between tree/editor views based on `UIStore.rightPanelState`
- DocumentTreePanel – container with header, search, tree rendering
- FolderTreeItem – collapsible folder (recursive)
- DocumentTreeItem – clickable document

**Store implementation:**
- `useTreeStore.loadTree(projectId)` – fetch and build tree structure
- Tree building algorithm to nest documents under folders

**Integration:**
- Read `UIStore.activeDocumentId` to highlight active document
- Call `openDocument(docId)` from panelHelpers when document clicked
- Use existing API: `api.documents.getTree(projectId)`

**Constraints:**
- Keep simple – no drag-drop, no virtualization (yet)
- Search is name filter only (not full-text)
- Use shadcn Collapsible component (don't rebuild)

---

### TipTap Editor (Phase 4.10-4.12)

**Purpose:** Rich text editor for document content.

**Components needed:**
- EditorPanel – container with header, TipTap editor, status bar
- Editor – TipTap React integration
- EditorStatusBar – word count, save status, back button

**Store implementation:**
- `useEditorStore.loadDocument(docId)` – fetch content
- `useEditorStore.saveDocument(docId, content)` – debounced save
- Auto-save pipeline with optimistic updates

**Integration:**
- Read `UIStore.activeDocumentId` to know which document to load
- Call `closeEditor()` from panelHelpers when back button clicked
- Use existing API: `api.documents.get(id)`, `api.documents.update(id, data)`

**Constraints:**
- Writing-first typography – `text-lg`, `leading-relaxed`, `max-w-4xl` (match active chat panel)
- Start with basic extensions (bold, italic, headings, lists)
- Debounce auto-save (2-3 seconds)
- Show save status indicator

**TipTap packages:**
- `@tiptap/react`
- `@tiptap/starter-kit`
- `@tiptap/extension-placeholder`
- `@tiptap/extension-character-count`

---

## File Locations

**Existing infrastructure:**
```
frontend/src/
├── core/
│   ├── lib/
│   │   ├── api.ts                    # API client (documents endpoints exist)
│   │   └── panelHelpers.ts           # openDocument(), closeEditor()
│   └── stores/
│       ├── useUIStore.ts             # Panel state (fully implemented)
│       ├── useTreeStore.ts           # Document tree (skeleton - needs implementation)
│       └── useEditorStore.ts         # Editor state (skeleton - needs implementation)
├── features/
│   └── documents/
│       └── types/
│           ├── document.ts           # Document, DocumentTree types
│           └── folder.ts             # Folder type
└── shared/components/layout/
    └── PanelLayout.tsx               # 3-panel container (ready to use)
```

**Create these:**
```
frontend/src/features/documents/
├── components/
│   ├── DocumentPanel.tsx             # Tree/Editor view switcher
│   ├── DocumentTreePanel.tsx         # Tree container
│   ├── FolderTreeItem.tsx            # Folder component (recursive)
│   ├── DocumentTreeItem.tsx          # Document component
│   ├── EditorPanel.tsx               # Editor container
│   └── Editor.tsx                    # TipTap integration
└── ... (other feature files as needed)
```

---

## Integration Points

### With WorkspaceLayout

WorkspaceLayout (in `frontend/src/app/projects/[id]/components/`) currently shows placeholders. Replace right panel placeholder with:
- Pass `projectId` to DocumentPanel
- Pass `UIStore.rightPanelState` to DocumentPanel to switch views
- DocumentPanel handles tree vs editor rendering

### With UIStore

**Reading state:**
- `rightPanelState` – which view to show ('documents' | 'editor')
- `rightPanelCollapsed` – whether panel is visible
- `activeDocumentId` – which document is active (for highlighting)

**Updating state:**
- Use `openDocument(docId)` helper – sets active doc, switches to editor, expands panel
- Use `closeEditor()` helper – switches back to tree, clears active doc
- Don't call setters directly – use helpers for coordinated updates

### With API

**Documents API:**
- `api.documents.getTree(projectId)` – fetch all documents/folders
- `api.documents.get(documentId)` – fetch single document content
- `api.documents.create(projectId, data)` – create new document
- `api.documents.update(documentId, data)` – save document changes

**Error handling:**
- API errors throw exceptions – catch and show user-friendly error
- Use existing ErrorPanel component for error states

---

## Design Guidelines

### Writing-First UI

**This is a writing app** – maximize space for content.

**Typography (match active chat panel):**
- Base: `text-lg` (18px)
- Line height: `leading-relaxed` (1.625)
- Max width: `max-w-4xl` (~65-75 characters)
- Padding: `px-8 py-12`

**Editor must feel spacious:**
- No cluttered toolbars
- Minimal chrome
- Focus on content

### Accessibility

**All interactive elements need:**
- aria-label or visible label
- Keyboard navigation support
- Focus indicators

**Refer to existing panel buttons** (`CollapsiblePanel.tsx`, `PanelLayout.tsx`) for aria-* patterns.

---

## Testing

**Verify these behaviors:**
- Click document in tree → editor opens with content
- Edit content → auto-saves after 2-3 seconds
- Click back button in editor → returns to tree view
- Active document highlighted in tree
- Panel collapse/expand still works
- Refresh page → right panel resets to tree view (rightPanelState not persisted)
- Refresh page → last active document ID persists (activeDocumentId persisted)

**Error scenarios:**
- Document fetch fails → show error state
- Save fails → show error, allow retry
- Empty tree → show empty state

---

## Common Pitfalls

**1. Mixing concerns in UIStore**
- UIStore is for UI state only (which panel, which entity active)
- Don't put document content or tree data in UIStore
- Document data belongs in TreeStore/EditorStore

**2. Not using panel helpers**
- Don't manually call `setActiveDocument()` + `setRightPanelState()` + `setRightPanelCollapsed()`
- Use `openDocument(docId)` – it handles all three

**3. Over-engineering tree**
- Start simple: basic folder collapse, document click
- Don't add drag-drop, context menus, virtualization until needed

**4. Editor toolbar bloat**
- Start with basics: bold, italic, headings, lists
- Don't add 20 extensions upfront – wait for user needs

**5. Ignoring autosave**
- Debounce saves (2-3 seconds)
- Show save status so user knows state
- Handle offline gracefully (queue saves)

---

## Acceptance Criteria

### Document Tree
- [ ] Tree renders with folders and documents
- [ ] Folders expand/collapse
- [ ] Clicking document opens editor
- [ ] Active document highlighted
- [ ] Search filters by document name
- [ ] Empty state when no documents
- [ ] Error handling for failed fetches

### Editor
- [ ] Opens with document content
- [ ] Basic formatting works (bold, italic, headings, lists)
- [ ] Auto-saves after 2-3 seconds of inactivity
- [ ] Shows save status indicator
- [ ] Back button returns to tree
- [ ] Word count displays
- [ ] Writing-first typography matches spec
- [ ] Error handling for save failures

### Integration
- [ ] Right panel switches between tree/editor correctly
- [ ] Panel coordination helpers work as expected
- [ ] State persistence correct (active ID persists, view resets)
- [ ] Build passes with no TypeScript errors

---

## Resources

**Phase 4 task files:**
- `_docs/hidden/tasks/mvp0/phase4/phase4.8-document-tree-ui.md` – Detailed tree requirements
- `_docs/hidden/tasks/mvp0/phase4/phase4.9-tree-building-algorithm.md` – Tree building logic
- `_docs/hidden/tasks/mvp0/phase4/phase4.10-tiptap-editor-setup.md` – TipTap integration
- `_docs/hidden/tasks/mvp0/phase4/phase4.11-lazy-loading-abort.md` – Loading optimizations
- `_docs/hidden/tasks/mvp0/phase4/phase4.12-auto-save-pipeline.md` – Auto-save implementation

**Phase 4.1 reference:**
- `_docs/technical/frontend/phase4.1-workspace-layout-shell.md` – Workspace layout documentation

**High-level product docs:**
- `_docs/high-level/mvp-0-spec.md` – MVP 0 requirements
- `_docs/high-level/ui-spec.md` – UI/UX specifications

---

## Estimated Timeline

**Document Tree:** 4-5 hours
- 1 hour: Components (DocumentPanel, TreePanel, tree items)
- 1 hour: Store implementation (loadTree, tree building)
- 1 hour: Integration (panel switching, highlighting)
- 1 hour: Polish (search, empty states, error handling)

**Editor:** 5-6 hours
- 1 hour: TipTap setup + basic extensions
- 2 hours: Editor integration (load, save, store)
- 1 hour: Auto-save + debouncing
- 1 hour: Status bar (word count, save status)
- 1 hour: Polish (back button, error handling, typography)

**Total: ~10 hours** for full document experience (tree + editor).

---

## Questions?

Reach out if you hit blockers or need clarification on:
- Panel coordination patterns
- Store architecture decisions
- API integration details
- Design/UX questions

The infrastructure is ready – build with confidence!
