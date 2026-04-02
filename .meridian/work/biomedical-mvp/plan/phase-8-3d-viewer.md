# Phase 8: 3D Viewer Component (v2)

**Round 4** — Depends on Phase 4 (binary mesh protocol), Phase 5 (frontend infra), and Phase 6 (MeshRefBlock triggers viewer).

## Scope

React Three Fiber canvas component in `frontend-v2/` for visualizing segmented bone meshes. Renders in the right panel's content area. Includes binary mesh parsing, label-based mesh splitting, color coding, structure toggle, and camera controls.

## Intent

The researcher needs to see the 3D segmentation to validate it ("that's a sesamoid, not an osteophyte"). This is the primary validation checkpoint in the pipeline. The viewer receives mesh data via WS binary frames, parsed and stored by the viewer store.

## Files to Create

- `frontend-v2/src/features/viewer-3d/Viewer3DPanel.tsx` + `.stories.tsx`
- `frontend-v2/src/features/viewer-3d/MeshScene.tsx` — Three.js scene
- `frontend-v2/src/features/viewer-3d/BoneMesh.tsx` — Per-label mesh
- `frontend-v2/src/features/viewer-3d/ViewerControls.tsx` — OrbitControls
- `frontend-v2/src/features/viewer-3d/StructureToggle.tsx` — Bone visibility toggles
- `frontend-v2/src/features/viewer-3d/ViewerToolbar.tsx` — Export, screenshot, reset
- `frontend-v2/src/features/viewer-3d/hooks/useMeshData.ts` — Binary parser (parseMeshBinary)
- `frontend-v2/src/features/viewer-3d/hooks/useViewerCamera.ts` — Camera auto-framing
- `frontend-v2/src/features/viewer-3d/types.ts` — MeshData, BoneStructure
- `frontend-v2/src/features/viewer-3d/constants.ts` — BONE_COLORS
- `frontend-v2/src/features/viewer-3d/index.ts`
- `frontend-v2/src/features/viewer-3d/examples/mock-mesh.ts` — Test meshes for Storybook

## Files to Modify

- `frontend-v2/src/features/workspace/ContentPanel.tsx` — Import and render Viewer3DPanel
- `frontend-v2/src/features/threads/streaming/ThreadWsProvider.tsx` — Wire onBinaryMessage to viewer store
- `frontend-v2/src/stores/viewer-store.ts` — May need adjustments based on implementation

## New Dependencies (npm)

```bash
cd frontend-v2
pnpm add @react-three/fiber @react-three/drei three
pnpm add -D @types/three
```

## Dependencies

- Requires: Phase 4 (binary mesh frame format definition)
- Requires: Phase 5 (viewer store, workspace store, ContentPanel)
- Requires: Phase 6 (MeshRefBlock dispatches to workspace store)
- Independent of: Phase 7 (dataset upload)

## Key Implementation Details

1. **Binary mesh parsing**: Parse WS binary frame with DataView for endianness. Copy to aligned buffers (D9).
2. **Label splitting**: Split full mesh into per-label BufferGeometry via face-level filtering
3. **WS wiring**: ThreadWsProvider.onBinaryMessage → parseMeshBinary → viewerStore.setMeshData → workspaceStore.showViewer
4. **Camera**: Default position based on mesh bounding box, OrbitControls for interaction
5. **Lighting**: Ambient (0.4) + two directional lights for good bone surface visibility
6. **Structure toggle**: shadcn Checkbox with color swatches, overlaid on canvas
7. **Performance**: BufferGeometry with pre-computed normals, static meshes, memoized splitting

## Patterns to Follow

- Feature module: `frontend-v2/src/features/` pattern
- Content switching: Same pattern as DatasetPanel in ContentPanel
- State: Viewer store for mesh data, workspace store for panel switching
- Components: shadcn/ui for toolbar buttons and checkboxes
- Stories: Mock meshes (not binary parsing) for Storybook

## Design Docs

- [3D Viewer](../../design/frontend/viewer-3d.md)
- [State Management](../../design/frontend/state.md) — viewer store + WS wiring

## Verification Criteria

- [ ] `pnpm run build` passes
- [ ] `pnpm run lint` passes
- [ ] Viewer renders a test mesh (mock data) in Storybook
- [ ] parseMeshBinary correctly handles aligned and unaligned binary frames
- [ ] Label splitting produces correct per-bone geometries
- [ ] Camera controls work (rotate, zoom, pan)
- [ ] Structure toggle hides/shows individual bones with correct colors
- [ ] Binary mesh parser handles vertex counts from 1K to 200K
- [ ] Viewer panel opens when MeshRefBlock "View 3D" is clicked (workspace store wiring)
- [ ] WS binary frame → viewer store → panel switch chain works

## Agent Staffing

- **Implementer**: `frontend-coder` -m opus (3D rendering requires spatial reasoning for geometry)
- **Reviewer**: 1x reviewer with correctness focus (binary parsing, geometry construction, typed array alignment)
- **Verifier**: `verifier` (build + lint)
- **Browser tester**: `browser-tester` (visual verification of 3D rendering if feasible)
