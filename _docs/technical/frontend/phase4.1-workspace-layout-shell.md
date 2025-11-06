---
detail: minimal
audience: developer
status: active
---

# Phase 4.1 – Workspace Layout Shell

## Purpose

Clarify the 3‑panel workspace shell implementation and which components own collapse controls vs sizing.

## Components

- Panel sizing/transitions: `frontend/src/shared/components/layout/PanelLayout.tsx` (shadcn Resizable).
- Collapse/expand controls: always in the center panel, rendered by `PanelLayout`.
- CollapsiblePanel: wraps panel content and hides it when collapsed (no internal toggle UI).

Behavior:
- 0-width (drag-to-edge) is treated as fully collapsed via `onCollapse`/`onExpand` and synced to the UI store.

## UI Store usage

Use the existing store in `frontend/src/core/stores/useUIStore.ts`:

- Left panel: `toggleLeftPanel()` to collapse/expand
- Right panel: `toggleRightPanel()` and `setRightPanelCollapsed(collapsed)`
- Right panel mode: `setRightPanelState('documents' | 'editor' | null)`

Notes:
- Call `toggleLeftPanel` for the left side (no `setLeftPanelCollapsed`).
- PanelLayout syncs drag-to-zero and drag-from-zero with these toggles.

## Next.js 16 route params

In `projects/[id]/page.tsx`, `params` is a Promise and must be awaited:

```1:10:frontend/src/app/projects/[id]/page.tsx
export default async function ProjectWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // ...
}
```

## Layout container

Wrap the shell in a viewport‑filling container so panels scroll independently:

- Use `h-screen w-full overflow-hidden` on the top wrapper
- Let each panel manage internal scroll with `overflow-auto`

