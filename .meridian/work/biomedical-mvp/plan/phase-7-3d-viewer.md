# Phase 7: 3D Viewer Component

**Round 4** — Depends on Phase 4 (binary mesh protocol) and Phase 5 (MeshRefBlock triggers viewer).

## Scope

React Three Fiber canvas component for visualizing segmented bone meshes. Renders in the right panel. Includes label-based mesh splitting, color coding, structure toggle, and camera controls.

## Intent

The researcher needs to see the 3D segmentation to validate it ("that's a sesamoid, not an osteophyte"). This is the primary validation checkpoint in the pipeline. The viewer receives mesh data via WS binary frames and renders color-coded bone structures.

## Files to Create

- `frontend/src/features/viewer-3d/Viewer3DPanel.tsx` — Panel wrapper with toolbar
- `frontend/src/features/viewer-3d/MeshScene.tsx` — Three.js scene setup
- `frontend/src/features/viewer-3d/BoneMesh.tsx` — Individual mesh per label
- `frontend/src/features/viewer-3d/ViewerControls.tsx` — Orbit controls
- `frontend/src/features/viewer-3d/StructureToggle.tsx` — Bone visibility toggles
- `frontend/src/features/viewer-3d/ViewerToolbar.tsx` — Export, screenshot, reset
- `frontend/src/features/viewer-3d/hooks/useMeshData.ts` — Binary parsing → Three.js geometry
- `frontend/src/features/viewer-3d/hooks/useViewerState.ts` — Local viewer state
- `frontend/src/features/viewer-3d/types.ts` — MeshData, BoneStructure types
- `frontend/src/features/viewer-3d/constants.ts` — BONE_COLORS map

## Files to Modify

- `frontend/src/features/documents/components/DocumentPanel.tsx` — Switch to Viewer3DPanel when activeMeshId is set
- `frontend/src/core/stores/ui-store.ts` — Add activeMeshId, meshData fields
- `frontend/src/features/threads/streaming/ThreadWsProvider.tsx` — Handle binary mesh frames via onBinaryMessage

## New Dependencies (npm)

```bash
pnpm add @react-three/fiber @react-three/drei three
pnpm add -D @types/three
```

## Key Implementation Details

1. **Binary mesh parsing**: Parse WS binary frame into Float32Array/Uint32Array. Zero-copy where possible (use typed array views into the ArrayBuffer).
2. **Label splitting**: Split full mesh into per-label BufferGeometry objects for independent rendering/toggling. Use face-level filtering (all 3 vertices must share the label).
3. **Camera**: Default position based on mesh bounding box. OrbitControls for interaction.
4. **Lighting**: Ambient (0.4) + two directional lights for good bone surface visibility.
5. **Structure toggle**: Checkboxes with color swatches, overlaid on the canvas.
6. **Performance**: Vertex normals computed once on load. Static meshes — no per-frame computation.

## Dependencies

- Requires: Phase 4 (binary mesh frame format must be defined)
- Requires: Phase 5 (MeshRefBlock dispatches activation to UI store)
- Independent of: Phase 6 (dataset upload)

## Patterns to Follow

- Feature module: `frontend/src/features/` pattern
- Panel switching: Same pattern as EditorPanel/SkillEditorPanel in DocumentPanel
- State management: UI store for cross-component state (activeMeshId)
- Components: Tailwind v4, shadcn/ui for toolbar buttons and checkboxes

## Verification Criteria

- [ ] `pnpm run build` passes
- [ ] `pnpm run lint` passes
- [ ] Viewer renders a test mesh (hardcoded data) in Storybook
- [ ] Label splitting produces correct per-bone geometries
- [ ] Camera controls work (rotate, zoom, pan)
- [ ] Structure toggle hides/shows individual bones
- [ ] Binary mesh parser handles vertex counts from 1K to 200K
- [ ] Viewer panel opens when MeshRefBlock "View 3D" is clicked

## Agent Staffing

- **Implementer**: `frontend-coder` -m opus (3D rendering requires spatial reasoning)
- **Reviewer**: 1x reviewer (correctness — binary parsing, geometry construction)
- **Verifier**: `verifier`
- **Browser tester**: `browser-tester` (visual verification of 3D rendering)
