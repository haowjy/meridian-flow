# Phase 8: 3D Viewer

**Round 3** — Requires Phase 6 (stores, layout) + Phase 7 (MeshRefBlock).

## Scope

Implement the React Three Fiber 3D viewer: mesh scene, per-label splitting, bone mesh rendering, structure toggle, viewer toolbar. Wire binary frame parsing to viewer store.

## Intent

The researcher needs to see and interact with 3D segmentation results. This phase builds the viewer panel that activates when mesh data arrives via WS binary frame.

## Files to Create

- `frontend-v2/src/features/viewer-3d/Viewer3DPanel.tsx`
- `frontend-v2/src/features/viewer-3d/Viewer3DPanel.stories.tsx`
- `frontend-v2/src/features/viewer-3d/MeshScene.tsx`
- `frontend-v2/src/features/viewer-3d/BoneMesh.tsx`
- `frontend-v2/src/features/viewer-3d/ViewerControls.tsx`
- `frontend-v2/src/features/viewer-3d/StructureToggle.tsx`
- `frontend-v2/src/features/viewer-3d/ViewerToolbar.tsx`
- `frontend-v2/src/features/viewer-3d/hooks/useMeshData.ts` — parseMeshBinary function
- `frontend-v2/src/features/viewer-3d/hooks/useViewerCamera.ts`
- `frontend-v2/src/features/viewer-3d/types.ts`
- `frontend-v2/src/features/viewer-3d/constants.ts` — BONE_COLORS
- `frontend-v2/src/features/viewer-3d/examples/mock-mesh.ts`

## Files to Modify

- `frontend-v2/package.json` — Add `@react-three/fiber`, `@react-three/drei`, `three`
- `frontend-v2/src/features/workspace/ContentPanel.tsx` — Replace viewer stub with Viewer3DPanel

## Dependencies

- Requires: Phase 6 (viewer store, workspace store, ContentPanel)
- Requires: Phase 7 (MeshRefBlock triggers viewer)

## Constraints

- `parseMeshBinary` must validate exact byte length before allocation (fixes p758 finding #4)
- Copy to aligned buffers before typed array construction (Decision D9)
- MAX_VERTEX_COUNT = 500,000; MAX_FACE_COUNT = 1,000,000
- `splitByLabel` memoized on meshData reference
- OrbitControls for rotate/zoom/pan
- BONE_COLORS is the single source of truth — imported by viewer store

## Verification Criteria

- [ ] `pnpm run lint` passes
- [ ] Storybook: Viewer3DPanel renders mock mesh with colored structures
- [ ] Storybook: StructureToggle toggles visibility
- [ ] parseMeshBinary: rejects truncated frames
- [ ] parseMeshBinary: rejects oversized frames
- [ ] parseMeshBinary: correctly parses valid mesh with labels

## Agent Staffing

- **Implementer**: `frontend-coder` (React Three Fiber)
- **Reviewer**: 1x reviewer (correctness — binary parsing, performance)
- **Verifier**: `verifier`
