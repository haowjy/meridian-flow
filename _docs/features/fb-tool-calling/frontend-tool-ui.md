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

## TextEditorBlock

**Purpose**: Specialized UI for `str_replace_based_edit_tool` interactions.

**Features**:
- Handles all commands: view, str_replace, create, insert
- Collapsible content preview (documents) or folder listing (folders)
- Collapsible diff preview for edit commands
- Status badges: Pending → Read/Applied/Error
- "View" button to navigate to document

**Files**:
- `frontend/src/features/threads/components/blocks/TextEditorBlock/`
- `frontend/src/features/threads/types/textEditor.ts`

---

## Shared Components

### FolderTreeView

**Purpose**: Reusable tree rendering component.

**Used by**: TextEditorBlock (folder view)

**Files**:
- `frontend/src/features/threads/components/blocks/shared/FolderTreeView.tsx`

---

## Related

- See [custom-tools.md](custom-tools.md) for backend tool definitions
