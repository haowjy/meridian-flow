---
detail: minimal
audience: developer
---

# Workspace Rail Audit (State & Headers)

## State Ownership

- `useUIStore` (`frontend/src/core/stores/useUIStore.ts`):
  - Owns `leftPanelCollapsed`, `rightPanelCollapsed`.
  - Owns `leftPanelSize`, `leftPanelLastSize`, `rightPanelSize`, `rightPanelLastSize`.
  - Provides `toggleLeftPanel`, `toggleRightPanel`, `setLeftPanelCollapsed`, `setRightPanelCollapsed`.
  - Persists collapse + size state via `persist` (localStorage key `ui-store`).

- `PanelLayout` (`frontend/src/shared/components/layout/PanelLayout.tsx`):
  - Receives `leftCollapsed`, `rightCollapsed`, sizes, and collapse callbacks as props.
  - Wraps three `ResizablePanel`s (left / center / right) from `react-resizable-panels`.
  - Uses a non-zero `collapsedSize` (4%) so Flow/Docs columns remain mounted as slim strips when collapsed, keeping edge icons aligned in the rail.

- `WorkspaceLayout` (`frontend/src/app/projects/[id]/components/WorkspaceLayout.tsx`):
  - Connects `useUIStore` to `PanelLayout` (passes collapse booleans, sizes, and `setPanelLayout`).
  - Wraps left/right content in `CollapsiblePanel`:
    - Left: `CollapsiblePanel side="left"` + `ChatListPanel`.
    - Right: `CollapsiblePanel side="right"` + `DocumentPanel`.
  - Uses effects to ensure:
    - Left panel is forced open on mount (migrating older persisted collapsed state).
    - Right panel state (`rightPanelState`) tracks tree vs editor based on URL/document selection.

## CollapsiblePanel & Toggles

- `CollapsiblePanel` (`frontend/src/shared/components/layout/CollapsiblePanel.tsx`):
  - Wraps children in a `role="region"` container and keeps them mounted regardless of collapsed state (children are responsible for hiding their bodies).
  - Provides context via `CollapsiblePanelProvider`; no floating chevrons anymore—the Flow/Docs headers own the toggles explicitly.

- Explicit edge toggles:
  - `FlowEdgeToggle` (`frontend/src/features/chats/components/FlowEdgeToggle.tsx`):
    - Reads `leftPanelCollapsed` from `useUIStore`.
    - Calls `toggleLeftPanel()` on click.
    - Renders a `MessagesSquare` button that swaps between `ghost`/`outline` while staying anchored at the far-left rail.
  - `DocsEdgeToggle` (`frontend/src/features/documents/components/DocsEdgeToggle.tsx`):
    - Reads `rightPanelCollapsed` from `useUIStore`.
    - Calls `toggleRightPanel()` on click.
    - Renders a `Folder` button anchored on the far-right rail.

- Explicit toggle components (center header today):
  - `ChatsToggleButton` (`frontend/src/features/chats/components/ChatsToggleButton.tsx`):
    - Reads `leftPanelCollapsed` from `useUIStore`.
    - Calls `toggleLeftPanel()` on click.
    - Renders `MessagesSquare` icon in a `Button` (variant = `ghost` when open, `outline` when collapsed).
  - `DocumentsToggleButton` (`frontend/src/features/chats/components/DocumentsToggleButton.tsx`):
    - Reads `rightPanelCollapsed` from `useUIStore`.
    - Calls `toggleRightPanel()` on click.
    - Renders `Folder` icon in a `Button` (same open/collapsed variants).

## Header Renderers by Column

- Left / Flow column:
  - `ChatListPanel` (`frontend/src/features/chats/components/ChatListPanel.tsx`):
    - Keeps `ChatListHeader` mounted at all times; hides the list body when `leftPanelCollapsed` is true.
  - `ChatListHeader` (`frontend/src/features/chats/components/ChatListHeader.tsx`):
    - Absolute layout: Flow edge toggle pinned to `left-3`, logo centered, “New Chat” button pinned to `right-3`.
    - When collapsed, only the `[ 💬 ]` button renders; center/right affordances hide to create the slim rail.

- Center / Chat column:
  - `ActiveChatView` (`frontend/src/features/chats/components/ActiveChatView.tsx`):
    - Header now shows only breadcrumbs + chat actions; collapse toggles live exclusively in Flow/Docs columns.
  - `ActiveChatHeader` (`frontend/src/features/chats/components/ActiveChatHeader.tsx`):
    - Left cluster: `ChatBreadcrumb`.
    - Right cluster: future chat actions (placeholder menu button).

- Right / Docs column:
  - `DocumentPanel` (`frontend/src/features/documents/components/DocumentPanel.tsx`):
    - Passes `rightPanelCollapsed` into `DocumentTreeContainer` / `EditorPanel` so they can render header-only strips when collapsed.
  - `DocumentTreePanel` (`frontend/src/features/documents/components/DocumentTreePanel.tsx`):
    - Header uses `<DocumentHeaderBar leading={<DocsEdgeToggle />} title=... trailing={search + create}>`.
    - Search + create controls live in the trailing slot; they hide entirely when collapsed.
  - `EditorHeader` (`frontend/src/features/documents/components/EditorHeader.tsx`):
    - Same breadcrumb layout, but wrapped in `DocumentHeaderBar` with `leading={<DocsEdgeToggle />}` and title hidden when collapsed.
  - `DocumentHeaderBar` (`frontend/src/features/documents/components/DocumentHeaderBar.tsx`):
    - Grid layout `auto | 1fr | auto` so the title naturally centers while leading/trailing stay pinned to edges.

## Header Height Alignment

- Token:
  - `frontend/src/app/globals.css` defines `--header-height: 2.75rem;` inside `@theme inline`.
- Utility:
  - Tailwind height utility `h-header` is used on:
    - Flow header root: `ChatListHeader` (`chat-pane-header h-header ...`).
    - Chat header root(s): `ActiveChatHeader` and the empty-state header in `ActiveChatView` (`chat-main-header h-header`).
    - Docs header base: `DocumentHeaderBar` root (`h-header flex items-center ...`).
- Result:
  - All three header segments share the same height token and align in a single visual top rail when rendered side by side.
