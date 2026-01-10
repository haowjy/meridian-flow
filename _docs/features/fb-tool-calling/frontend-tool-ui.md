---
stack: frontend
status: complete
feature: "Tool UI Components"
---

# Tool UI Components

**Extensible registry for custom tool block renderers.**

## Status: ✅ Complete

---

## Tool UI Registry

**Purpose**: Route tool blocks to specialized UI components.

**Pattern**: `getToolRenderer(toolName)` - registered tools get custom UI, others use `ToolInteractionBlock`.

**File**: `frontend/src/features/threads/components/blocks/toolRegistry.ts`

**Adding a Custom Tool UI**:
1. Create component in `blocks/YourToolBlock/`
2. Register: `TOOL_RENDERERS['tool_name'] = (toolUse, toolResult) => <YourComponent />`

---

## DocEditBlock

**Purpose**: Specialized UI for `doc_edit` tool interactions.

**Features**:
- Collapsible diff preview
- Status badges: Pending → Applied/Error
- "View" button to navigate to document
- Error messages and warnings

**Files**:
- `frontend/src/features/threads/components/blocks/DocEditBlock/`
- `frontend/src/features/threads/utils/docPathResolver.ts`

---

## DocViewBlock

**Purpose**: Specialized UI for `doc_view` tool interactions.

**Features**:
- Collapsible content preview (documents) or folder listing (folders)
- Status badges: Pending → Read/Error
- "View" button to navigate to document
- Word count and truncation warnings

**Files**:
- `frontend/src/features/threads/components/blocks/DocViewBlock/`

---

## DocTreeBlock

**Purpose**: Specialized UI for `doc_tree` tool interactions.

**Features**:
- Collapsible project tree hierarchy
- Status badges: Pending → Traversed/Error
- Click to navigate to documents

**Files**:
- `frontend/src/features/threads/components/blocks/DocTreeBlock/`

---

## Shared Components

### FolderTreeView

**Purpose**: Reusable tree rendering component.

**Used by**: DocViewBlock, DocTreeBlock

**Files**:
- `frontend/src/features/threads/components/blocks/shared/FolderTreeView.tsx`

---

## Related

- See [custom-tools.md](custom-tools.md) for backend tool definitions
