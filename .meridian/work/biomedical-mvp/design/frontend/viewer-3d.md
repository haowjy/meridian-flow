# 3D Viewer Component

React Three Fiber canvas for visualizing segmented bone meshes. Renders in the right panel's content area. Supports **multi-mesh scenes** where each `show_mesh()` call adds or replaces a named mesh. See [overview](overview.md) for frontend architecture context.

## Multi-Mesh Scene Model

The AI controls the scene through mesh IDs:

- `show_mesh(verts, faces, mesh_id="femur", label="Femur", color="#4488ff")` — adds a mesh
- Same `mesh_id` = replaces existing mesh (e.g. re-running segmentation with different params)
- New `mesh_id` = adds to scene (building up the anatomy)
- All meshes are loaded simultaneously
- User toggles visibility per mesh via checkboxes

**No per-vertex label splitting on frontend.** Each `show_mesh()` call is one complete mesh with one color. The AI handles decomposition — it calls `show_mesh()` once per structure.

## Placement in Layout

The viewer is one of the content types in the right panel. It activates when:
1. A `DISPLAY_RESULT` event with `resultType: "mesh_ref"` arrives → auto-switch via workspace store
2. User clicks "View 3D" in a `MeshRefBlock` → explicit switch via workspace store

See [layout.md](layout.md) for the content panel switching mechanism and [state.md](state.md) for the workspace store.

```
ContentPanel
+-- activeContent.type === "viewer"   -> Viewer3DPanel
+-- activeContent.type === "datasets" -> DatasetPanel
+-- activeContent.type === "editor"   -> EditorPanel
+-- activeContent.type === "empty"    -> EmptyState
```

## Component Architecture

```
features/viewer-3d/
+-- Viewer3DPanel.tsx              # Panel wrapper (toolbar + canvas)
+-- Viewer3DPanel.stories.tsx      # Storybook story with mock meshes
+-- MeshScene.tsx                  # Three.js scene with camera, lights, all meshes
+-- BoneMesh.tsx                   # Individual mesh component
+-- ViewerControls.tsx             # Orbit controls + reset camera
+-- StructureToggle.tsx            # Toggle visibility per mesh (checkboxes)
+-- ViewerToolbar.tsx              # Export, screenshot, reset buttons
+-- hooks/
|   +-- useMeshData.ts             # Parses binary mesh data into Three.js geometry
|   +-- useViewerCamera.ts         # Camera reset and auto-framing
+-- types.ts                       # MeshData types
+-- examples/
    +-- mock-mesh.ts               # Test mesh data for Storybook
```

## Data Types

```typescript
// features/viewer-3d/types.ts

/** Single mesh in the scene. One per show_mesh() call. */
export interface MeshData {
  meshId: string          // AI-chosen ID (e.g. "femur")
  vertices: Float32Array  // [x,y,z, x,y,z, ...] flat
  faces: Uint32Array      // [v0,v1,v2, v0,v1,v2, ...] flat
  vertexCount: number
  faceCount: number
  label: string           // Display name (e.g. "Femur")
  color: string           // Hex color (e.g. "#4488ff")
}
```

**Simplified from previous design**: No `labels: Uint8Array` (per-vertex labels), no `labelNames` map, no `BoneStructure` type. Each mesh IS a structure. The viewer store holds a `Record<string, MeshData>` — one entry per mesh ID.

## Binary Data Parsing

The WS binary frame arrives at `WsClient.onBinaryMessage`. The `ThreadWsProvider` calls this parser and stores the result in the viewer store. See [state.md](state.md) for the wiring.

```typescript
// features/viewer-3d/hooks/useMeshData.ts

/** Upper bound: 500K vertices (~6MB binary). Reject frames larger than this. */
const MAX_VERTEX_COUNT = 500_000
const MAX_FACE_COUNT = 1_000_000

export function parseMeshBinary(data: Uint8Array): { meshId: string; vertices: Float32Array; faces: Uint32Array; vertexCount: number; faceCount: number } | null {
  try {
    // Find mesh_id (null-terminated UTF-8 string prefix)
    const nullIdx = data.indexOf(0x00)
    if (nullIdx < 0 || nullIdx > 255) return null
    const meshId = new TextDecoder().decode(data.slice(0, nullIdx))
    let offset = nullIdx + 1

    if (data.byteLength - offset < 8) return null

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const vertexCount = view.getUint32(offset, true); offset += 4
    const faceCount = view.getUint32(offset, true); offset += 4

    if (vertexCount > MAX_VERTEX_COUNT || faceCount > MAX_FACE_COUNT) {
      console.error(`[viewer-3d] Mesh too large: ${vertexCount} vertices, ${faceCount} faces`)
      return null
    }
    if (vertexCount === 0 || faceCount === 0) return null

    const vertexBytes = vertexCount * 3 * 4
    const faceBytes = faceCount * 3 * 4
    const expectedRemaining = vertexBytes + faceBytes
    const actualRemaining = data.byteLength - offset

    if (actualRemaining < expectedRemaining) {
      console.error(`[viewer-3d] Truncated frame: expected ${expectedRemaining}, got ${actualRemaining}`)
      return null
    }

    // Copy into aligned buffers (Decision D9: alignment safety)
    const vertexBuf = new ArrayBuffer(vertexBytes)
    new Uint8Array(vertexBuf).set(data.slice(offset, offset + vertexBytes))
    const vertices = new Float32Array(vertexBuf)
    offset += vertexBytes

    const faceBuf = new ArrayBuffer(faceBytes)
    new Uint8Array(faceBuf).set(data.slice(offset, offset + faceBytes))
    const faces = new Uint32Array(faceBuf)

    return { meshId, vertices, faces, vertexCount, faceCount }
  } catch (err) {
    console.error("[viewer-3d] Failed to parse mesh binary frame:", err)
    return null
  }
}
```

**Simplified from previous design**: No per-vertex label bytes in the binary frame. Binary contains only vertices + faces. The `label` and `color` come from the DISPLAY_RESULT event metadata, merged by the viewer store.

## Scene Setup

The scene renders ALL meshes in the store simultaneously:

```tsx
// features/viewer-3d/MeshScene.tsx

import { Canvas } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"

function MeshScene() {
  const meshes = useViewerStore((s) => s.meshes)
  const meshVisibility = useViewerStore((s) => s.meshVisibility)

  const meshEntries = useMemo(() => Object.values(meshes), [meshes])

  return (
    <Canvas camera={{ position: [0, 0, 150], fov: 50 }}>
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 10, 5]} intensity={0.8} />
      <directionalLight position={[-10, -10, -5]} intensity={0.3} />

      {meshEntries.map((mesh) => (
        <BoneMesh
          key={mesh.meshId}
          meshData={mesh}
          visible={meshVisibility[mesh.meshId] ?? true}
        />
      ))}

      <OrbitControls
        enableDamping
        dampingFactor={0.1}
        rotateSpeed={0.8}
        zoomSpeed={1.2}
      />
    </Canvas>
  )
}
```

**No per-label mesh splitting.** Each mesh is already one structure. The `BoneMesh` component renders the geometry directly:

## BoneMesh Component

```tsx
// features/viewer-3d/BoneMesh.tsx

function BoneMesh({
  meshData,
  visible,
}: {
  meshData: MeshData
  visible: boolean
}) {
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.Float32BufferAttribute(meshData.vertices, 3))
    geo.setIndex(Array.from(meshData.faces))
    geo.computeVertexNormals()
    return geo
  }, [meshData])

  if (!visible) return null

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={meshData.color}
        roughness={0.6}
        metalness={0.1}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}
```

## Viewer3DPanel

Panel wrapper with toolbar and structure toggle overlay:

```tsx
// features/viewer-3d/Viewer3DPanel.tsx

function Viewer3DPanel() {
  const meshes = useViewerStore((s) => s.meshes)
  const hasMeshes = Object.keys(meshes).length > 0

  if (!hasMeshes) {
    return <ViewerEmptyState />
  }

  return (
    <div className="relative h-full">
      <ViewerToolbar />
      <MeshScene />
      <StructureToggle />
    </div>
  )
}
```

## StructureToggle

Overlaid on the canvas, shows checkboxes for each mesh in the scene:

```tsx
// features/viewer-3d/StructureToggle.tsx

import { Checkbox } from "@/components/ui/checkbox"
import { useViewerStore } from "@/stores/viewer-store"

function StructureToggle() {
  const meshes = useViewerStore((s) => s.meshes)
  const meshVisibility = useViewerStore((s) => s.meshVisibility)
  const toggleMesh = useViewerStore((s) => s.toggleMesh)

  const meshList = useMemo(() => Object.values(meshes), [meshes])
  if (meshList.length === 0) return null

  return (
    <div className="absolute right-4 top-4 rounded-lg border bg-background/90 p-3 backdrop-blur">
      <h4 className="mb-2 text-sm font-medium">Structures</h4>
      {meshList.map((mesh) => (
        <label key={mesh.meshId} className="flex items-center gap-2 py-1">
          <Checkbox
            checked={meshVisibility[mesh.meshId] ?? true}
            onCheckedChange={() => toggleMesh(mesh.meshId)}
          />
          <div
            className="h-3 w-3 rounded-full"
            style={{ background: mesh.color }}
          />
          <span className="text-sm">{mesh.label}</span>
        </label>
      ))}
    </div>
  )
}
```

## ViewerToolbar

```tsx
function ViewerToolbar() {
  return (
    <div className="absolute left-4 top-4 z-10 flex gap-1">
      <Button variant="ghost" size="sm" onClick={handleScreenshot}>
        <Camera className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={handleResetView}>
        <ArrowsClockwise className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={handleExportSTL}>
        <DownloadSimple className="h-4 w-4" />
      </Button>
    </div>
  )
}
```

## Interactions

| Action | Behavior |
|--------|----------|
| Left drag | Rotate (OrbitControls) |
| Scroll | Zoom |
| Right drag / Shift+left | Pan |
| Reset button | Camera returns to default |
| Structure checkbox | Toggle individual mesh visibility |
| Export STL | Download all visible meshes as STL |
| Screenshot | Save canvas as PNG |

## Performance

Expected mesh sizes from the imaging pipeline:
- Per-bone: ~10K-50K vertices, ~20K-100K faces
- Total scene: 3-6 meshes simultaneously
- ~50K-200K total vertices across all meshes

React Three Fiber handles this easily. Optimizations:
- `BufferGeometry` with pre-computed indices
- Vertex normals computed once on load, not per frame
- Geometry memoized on meshData reference
- Each mesh is an independent `<mesh>` element — toggling visibility is a React prop change

## Dependencies

```
@react-three/fiber        # React renderer for Three.js
@react-three/drei         # Helpers (OrbitControls, etc.)
three                     # Three.js core
```

## Storybook

`Viewer3DPanel.stories.tsx` uses mock meshes from `examples/mock-mesh.ts`:
- Single cube mesh (test geometry correctness)
- Multi-mesh scene (3 separate meshes with different colors — test scene composition)
- Large mesh (performance test with 100K vertices)

## Sandbox Stopped State

When the user reloads and mesh data is not in memory (binary data is transient):

```tsx
function ViewerEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
      <Cube className="mb-4 h-12 w-12" />
      <p className="text-sm">No active 3D model</p>
      <p className="mt-1 text-xs">Run a segmentation to generate a 3D view</p>
    </div>
  )
}
```

Mesh geometry is transient (WS binary frame, not persisted to DB). After page reload:

- The persisted `display_result` turn blocks with `mesh_ref` metadata still exist, so MeshRefBlock cards render in the chat.
- The viewer store has no mesh data (binary was in-memory only).
- Clicking "View 3D" on MeshRefBlock checks `viewerStore.meshes[meshId]` — if missing, the button shows disabled: "3D data not loaded — ask the agent to regenerate the model."
- The 3D Viewer tab in ContentToolbar is hidden when the mesh store is empty.

## Related Docs

- [Layout](layout.md) — content panel hosting the viewer
- [State Management](state.md) — viewer store, WS binary frame wiring
- [Activity Stream](activity-stream.md) — DISPLAY_RESULT creates MeshRefBlock
- [Inline Results](inline-results.md) — MeshRefBlock triggers viewer
- [Display Result Pipeline (backend)](../backend/display-results.md) — binary mesh frame protocol
