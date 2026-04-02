# Workspace Layout

Two-panel resizable workspace layout using `react-resizable-panels`. Chat on the left, switchable content on the right. This is v2's Phase 6 (Layouts), built specifically for the biomedical workflow. See [overview](overview.md) for how this fits into the frontend architecture.

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
├── WorkspaceLayout.stories.tsx # Storybook story
└── index.ts
```

## WorkspaceLayout

```tsx
// features/workspace/WorkspaceLayout.tsx

import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"

function WorkspaceLayout() {
  return (
    <PanelGroup direction="horizontal" className="h-screen">
      <Panel
        defaultSize={45}
        minSize={30}
        maxSize={70}
        className="flex flex-col"
      >
        <ChatPanel />
      </Panel>

      <PanelResizeHandle className="w-1.5 bg-border/50 hover:bg-accent-fill/30 transition-colors" />

      <Panel
        defaultSize={55}
        minSize={30}
        className="flex flex-col"
      >
        <ContentPanel />
      </Panel>
    </PanelGroup>
  )
}
```

**Panel defaults**: Chat at 45%, content at 55%. The content panel is slightly larger because the 3D viewer and data tables benefit from more space. Min 30% prevents either panel from being too small to be useful.

## ChatPanel

Wraps the existing `FloatingScrollLayout` + `TurnList` + `ChatComposer`:

```tsx
// features/workspace/ChatPanel.tsx

function ChatPanel() {
  const threadId = useWorkspaceStore(s => s.activeThreadId)

  return (
    <FloatingScrollLayout
      autoScrollToBottom={isStreaming}
      isStreaming={isStreaming}
      bottomSlot={
        <div className="pointer-events-none px-4 pb-4 pt-8 [mask-image:linear-gradient(transparent,black_24px)]">
          <div className="pointer-events-auto mx-auto w-full max-w-4xl">
            <ChatComposer
              isStreaming={isStreaming}
              onSubmit={handleSubmit}
              onStop={handleStop}
            />
          </div>
        </div>
      }
    >
      <div className="py-4">
        <TurnList turns={turns} activeTurnId={activeTurnId} />
      </div>
    </FloatingScrollLayout>
  )
}
```

The ChatPanel consumes turn data from the thread streaming infrastructure (existing `ThreadWsProvider` + `StreamingChannelClient`).

## ContentPanel

Switches between content views based on workspace state:

```tsx
// features/workspace/ContentPanel.tsx

function ContentPanel() {
  const activeContent = useWorkspaceStore(s => s.activeContent)

  return (
    <div className="flex h-full flex-col">
      <ContentToolbar />
      <div className="flex-1 min-h-0">
        {activeContent.type === "viewer" && (
          <Viewer3DPanel meshId={activeContent.meshId} />
        )}
        {activeContent.type === "datasets" && (
          <DatasetPanel projectId={activeContent.projectId} />
        )}
        {activeContent.type === "editor" && (
          <div className="h-full">
            {/* CM6 editor — existing */}
          </div>
        )}
        {activeContent.type === "empty" && (
          <EmptyState />
        )}
      </div>
    </div>
  )
}
```

## ContentToolbar

Tab bar for switching between content views. Shows available content types with active indicator:

```tsx
// features/workspace/ContentToolbar.tsx

function ContentToolbar() {
  const {
    activeContent,
    activeProjectId,
    viewerMeshId,
    setActiveContent,
    showViewer,
    showDatasets,
  } = useWorkspaceStore(
    s => ({
      activeContent: s.activeContent,
      activeProjectId: s.activeProjectId,
      viewerMeshId: s.viewerMeshId,
      setActiveContent: s.setActiveContent,
      showViewer: s.showViewer,
      showDatasets: s.showDatasets,
    })
  )

  return (
    <div className="flex items-center gap-1 border-b px-3 py-1.5">
      <Button
        variant={activeContent.type === "datasets" ? "secondary" : "ghost"}
        size="sm"
        onClick={showDatasets}
        disabled={!activeProjectId}
      >
        <Database className="mr-1.5 h-4 w-4" />
        Datasets
      </Button>

      {viewerMeshId && (
        <Button
          variant={activeContent.type === "viewer" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => showViewer(viewerMeshId)}
        >
          <Cube className="mr-1.5 h-4 w-4" />
          3D Viewer
        </Button>
      )}

      <Button
        variant={activeContent.type === "editor" ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setActiveContent({ type: "editor" })}
      >
        <PencilSimple className="mr-1.5 h-4 w-4" />
        Editor
      </Button>
    </div>
  )
}
```

The 3D Viewer tab only appears when mesh data has been received. Datasets tab is always visible. Editor tab is for the existing CM6 document editor.

## EmptyState

Shown when the right panel has no active content:

```tsx
function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
      <FlaskConical className="mb-4 h-12 w-12" />
      <p className="text-sm font-medium">Ready for analysis</p>
      <p className="mt-1 text-xs">Upload datasets or start a conversation to begin</p>
    </div>
  )
}
```

## Content Switching

The right panel switches content based on user actions and incoming events:

| Trigger | Content Switch |
|---------|---------------|
| `PYTHON_RESULT` with `mesh_ref` arrives | → Viewer3D (auto-switch) |
| User clicks "View 3D" in MeshRefBlock | → Viewer3D |
| User clicks "Datasets" tab | → DatasetPanel |
| User clicks "Editor" tab | → Editor |
| Page load (no state) | → EmptyState or Datasets |

Auto-switching to the 3D viewer when mesh data arrives is the key UX interaction: the researcher asks for segmentation, and the 3D model appears in the right panel automatically.

## Responsive Behavior

For the biomedical MVP, the workspace is desktop-only (researchers use large monitors). No mobile layout is needed.

Minimum viewport: 1024px wide. Below that, a simple message: "Please use a wider screen for the analysis workspace."

## Dependencies

```
react-resizable-panels    # Panel layout with resize handles
```

Already available in v2:
- `FloatingScrollLayout` — chat scroll management
- `TurnList`, `TurnRow` — turn rendering
- `ChatComposer` — message input
- All shadcn/ui atoms

## Related Docs

- [State Management](state.md) — workspace store drives content switching
- [3D Viewer](viewer-3d.md) — Viewer3DPanel component
- [Dataset Upload](dataset-upload.md) — DatasetPanel component
- [Activity Stream Extensions](activity-stream-extensions.md) — PYTHON_RESULT triggers content switch
