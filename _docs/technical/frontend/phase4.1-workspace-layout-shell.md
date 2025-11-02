---
detail: minimal
audience: developer
status: active
---

# Phase 4.1 – Workspace Layout Shell

## Purpose

Clarify the 3‑panel workspace shell implementation and which components own collapse controls vs sizing.

## Components

- Panel sizing/transitions: see `frontend/src/shared/components/layout/PanelLayout.tsx`.
- Collapse/expand buttons: see `frontend/src/shared/components/layout/CollapsiblePanel.tsx`.

PanelLayout sets widths (25% | flex‑1 | 25%) and animates to `w-0` when a side is collapsed. CollapsiblePanel renders the actual toggle button and wraps panel content.

## UI Store usage

Use the existing store in `frontend/src/core/stores/useUIStore.ts`:

- Left panel: `toggleLeftPanel()` to collapse/expand
- Right panel: `toggleRightPanel()` and `setRightPanelCollapsed(collapsed)`
- Right panel mode: `setRightPanelState('documents' | 'editor' | null)`

Note: Docs/examples should call `toggleLeftPanel` for the left side (no `setLeftPanelCollapsed` function is provided at this time).

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


