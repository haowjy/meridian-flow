# Workspace Layout

Two-panel resizable workspace layout using `react-resizable-panels`. Chat on the left, switchable content on the right. Desktop-only. See [overview](overview.md) for how this fits into the frontend architecture.

**Minor revision from previous design**: Updated content switching triggers to use `DISPLAY_RESULT` events instead of `PYTHON_RESULT`. Layout structure unchanged.

## Layout Structure

```
┌──────────────────────────────────────────────────────────┐
│ WorkspaceLayout                                          │
│ ┌─────────────────────┬──┬──────────────────────────────┐│
│ │ ChatPanel           │░░│ ContentPanel                 ││
│ │                     │░░│                              ││
│ │ ┌─────────────────┐ │░░│ ┌──────────────────────────┐ ││
│ │ │ Thread header    │ │░░│ │ ContentToolbar           │ ││
│ │ ├─────────────────┤ │░░│ ├──────────────────────────┤ ││
│ │ │                 │ │░░│ │                          │ ││
│ │ │ TurnList        │ │░░│ │ Active content:          │ ││
│ │ │ (scrollable)    │ │░░│ │  - Viewer3DPanel         │ ││
│ │ │                 │ │░░│ │  - DatasetPanel          │ ││
│ │ │                 │ │░░│ │  - EditorPanel           │ ││
│ │ │                 │ │░░│ │  - EmptyState            │ ││
│ │ ├─────────────────┤ │░░│ │                          │ ││
│ │ │ ChatComposer    │ │░░│ │                          │ ││
│ │ └─────────────────┘ │░░│ └──────────────────────────┘ ││
│ └─────────────────────┴──┴──────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
  ░░ = resize handle
```

## Component Architecture

```
features/workspace/
├── WorkspaceLayout.tsx         # PanelGroup with two panels
├── ChatPanel.tsx               # Left panel: FloatingScrollLayout + TurnList + Composer
├── ContentPanel.tsx            # Right panel: content switcher
├── ContentToolbar.tsx          # Tab bar for right panel content
├── EmptyState.tsx              # Right panel when nothing is active
├── WorkspaceLayout.stories.tsx
└── index.ts
```

## WorkspaceLayout

```tsx
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"

function WorkspaceLayout() {
  return (
    <PanelGroup direction="horizontal" className="h-screen">
      <Panel defaultSize={45} minSize={30} maxSize={70} className="flex flex-col">
        <ChatPanel />
      </Panel>
      <PanelResizeHandle className="w-1.5 bg-border/50 hover:bg-accent-fill/30 transition-colors" />
      <Panel defaultSize={55} minSize={30} className="flex flex-col">
        <ContentPanel />
      </Panel>
    </PanelGroup>
  )
}
```

## ContentPanel

Switches based on workspace state:

```tsx
function ContentPanel() {
  const activeContent = useWorkspaceStore(s => s.activeContent)

  return (
    <div className="flex h-full flex-col">
      <ContentToolbar />
      <div className="flex-1 min-h-0">
        {activeContent.type === "viewer" && <Viewer3DPanel meshId={activeContent.meshId} />}
        {activeContent.type === "datasets" && <DatasetPanel projectId={activeContent.projectId} />}
        {activeContent.type === "editor" && <div className="h-full">{/* CM6 editor */}</div>}
        {activeContent.type === "empty" && <EmptyState />}
      </div>
    </div>
  )
}
```

## ContentToolbar

```tsx
function ContentToolbar() {
  const { activeContent, activeProjectId, viewerMeshId, showViewer, showDatasets, setActiveContent } =
    useWorkspaceStore(s => ({
      activeContent: s.activeContent,
      activeProjectId: s.activeProjectId,
      viewerMeshId: s.viewerMeshId,
      showViewer: s.showViewer,
      showDatasets: s.showDatasets,
      setActiveContent: s.setActiveContent,
    }))

  return (
    <div className="flex items-center gap-1 border-b px-3 py-1.5">
      <Button variant={activeContent.type === "datasets" ? "secondary" : "ghost"}
        size="sm" onClick={showDatasets} disabled={!activeProjectId}>
        <Database className="mr-1.5 h-4 w-4" /> Datasets
      </Button>
      {viewerMeshId && (
        <Button variant={activeContent.type === "viewer" ? "secondary" : "ghost"}
          size="sm" onClick={() => showViewer(viewerMeshId)}>
          <Cube className="mr-1.5 h-4 w-4" /> 3D Viewer
        </Button>
      )}
      <Button variant={activeContent.type === "editor" ? "secondary" : "ghost"}
        size="sm" onClick={() => setActiveContent({ type: "editor" })}>
        <PencilSimple className="mr-1.5 h-4 w-4" /> Editor
      </Button>
    </div>
  )
}
```

## Content Switching

| Trigger | Content Switch |
|---------|---------------|
| `DISPLAY_RESULT` with `mesh_ref` arrives | → Viewer3D (auto-switch via binary frame handler) |
| User clicks "View 3D" in MeshRefBlock | → Viewer3D |
| User clicks "Datasets" tab | → DatasetPanel |
| User clicks "Editor" tab | → Editor |
| Page load (no state) | → EmptyState or Datasets |

## Dependencies

```
react-resizable-panels    # Panel layout with resize handles
```

## Related Docs

- [State Management](state.md) — workspace store drives content switching
- [3D Viewer](viewer-3d.md) — Viewer3DPanel component
- [Dataset Upload](dataset-upload.md) — DatasetPanel component
- [Activity Stream](activity-stream.md) — DISPLAY_RESULT triggers content switch
