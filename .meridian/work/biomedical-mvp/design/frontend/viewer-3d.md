# 3D Viewer Component

React Three Fiber canvas for visualizing segmented bone meshes. Renders in the right panel's content area. See [overview](overview.md) for frontend architecture context.

## Placement in Layout

The viewer is one of the content types in the right panel's `ContentPanel`. It activates when:
1. A `DISPLAY_RESULT` event with `resultType: "mesh_ref"` arrives → auto-switch via workspace store
2. User clicks "View 3D" in a `MeshRefBlock` → explicit switch via workspace store

See [layout.md](layout.md) for the content panel switching mechanism and [state.md](state.md) for the workspace store.

```
ContentPanel
├── activeContent.type === "viewer"   → Viewer3DPanel
├── activeContent.type === "datasets" → DatasetPanel
├── activeContent.type === "editor"   → EditorPanel
└── activeContent.type === "empty"    → EmptyState
```

## Component Architecture

```
features/viewer-3d/
├── Viewer3DPanel.tsx              # Panel wrapper (toolbar + canvas)
├── Viewer3DPanel.stories.tsx      # Storybook story with mock mesh
├── MeshScene.tsx                  # Three.js scene with camera, lights, meshes
├── BoneMesh.tsx                   # Individual mesh component per label
├── ViewerControls.tsx             # Orbit controls + reset camera
├── StructureToggle.tsx            # Toggle visibility per bone structure
├── ViewerToolbar.tsx              # Export, screenshot, reset buttons
├── hooks/
│   ├── useMeshData.ts             # Parses binary mesh data into Three.js geometries
│   └── useViewerCamera.ts         # Camera reset and auto-framing
├── types.ts                       # MeshData, BoneStructure types
├── constants.ts                   # BONE_COLORS map
└── examples/
    └── mock-mesh.ts               # Test mesh data for Storybook
```

## Data Types

```typescript
// features/viewer-3d/types.ts

export interface MeshData {
  meshId: string
  vertices: Float32Array     // [x,y,z, x,y,z, ...] flat
  faces: Uint32Array         // [v0,v1,v2, v0,v1,v2, ...] flat
  labels: Uint8Array         // Per-vertex label (0 = unlabeled)
  vertexCount: number
  faceCount: number
  labelNames: Record<string, string>  // String keys from JSON
}

export interface BoneStructure {
  label: number
  name: string
  color: string
}

// features/viewer-3d/constants.ts
export const BONE_COLORS: Record<string, string> = {
  femur: "#4488ff",      // Blue
  tibia: "#44cc66",      // Green
  patella: "#9966cc",    // Purple
  osteophyte: "#ff4444", // Red
}
```

**Note on `labelNames`**: JSON object keys are always strings. The backend sends `{ "1": "femur", "2": "tibia" }`. Use string keys throughout; convert to number only for array indexing into `labels`.

## Binary Data Parsing

The WS binary frame arrives at `WsClient.onBinaryMessage`. The `ThreadWsProvider` calls this parser and stores the result in the viewer store. See [state.md](state.md) for the wiring.

```typescript
// features/viewer-3d/hooks/useMeshData.ts

/** Upper bound: 500K vertices (~18MB binary). Reject frames larger than this. */
const MAX_VERTEX_COUNT = 500_000
const MAX_FACE_COUNT = 1_000_000

export function parseMeshBinary(data: Uint8Array): MeshData | null {
  try {
    // Find mesh_id (null-terminated UTF-8 string prefix)
    const nullIdx = data.indexOf(0x00)
    if (nullIdx < 0 || nullIdx > 255) return null  // mesh_id sanity check
    const meshId = new TextDecoder().decode(data.slice(0, nullIdx))
    let offset = nullIdx + 1

    // Need at least 8 bytes for vertex/face counts
    if (data.byteLength - offset < 8) return null

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const vertexCount = view.getUint32(offset, true); offset += 4
    const faceCount = view.getUint32(offset, true); offset += 4

    // Sanity checks: reject corrupt or oversized frames
    if (vertexCount > MAX_VERTEX_COUNT || faceCount > MAX_FACE_COUNT) {
      console.error(`[viewer-3d] Mesh too large: ${vertexCount} vertices, ${faceCount} faces`)
      return null
    }
    if (vertexCount === 0 || faceCount === 0) return null

    // Validate exact byte length before any allocation
    const vertexBytes = vertexCount * 3 * 4   // float32 x,y,z per vertex
    const faceBytes = faceCount * 3 * 4       // uint32 v0,v1,v2 per face
    const labelBytes = vertexCount             // uint8 per vertex
    const expectedRemaining = vertexBytes + faceBytes + labelBytes
    const actualRemaining = data.byteLength - offset

    if (actualRemaining < expectedRemaining) {
      console.error(
        `[viewer-3d] Truncated frame: expected ${expectedRemaining} bytes, got ${actualRemaining}`
      )
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
    offset += faceBytes

    // Labels are uint8 — no alignment needed, but copy for safety
    const labels = new Uint8Array(data.slice(offset, offset + labelBytes))

    return { meshId, vertices, faces, labels, vertexCount, faceCount, labelNames: {} }
  } catch (err) {
    console.error("[viewer-3d] Failed to parse mesh binary frame:", err)
    return null
  }
}
```

**Important**: The `labelNames` field is NOT in the binary frame — it comes from the `DISPLAY_RESULT` event's `mesh_ref` data. The viewer store uses a two-step merge: `setPendingLabels()` stores names from DISPLAY_RESULT, then `receiveBinaryMesh()` merges them when the binary frame arrives. This handles the race between SSE and WS delivery. See [state.md](state.md) for the merge logic.

## Scene Setup

```tsx
// features/viewer-3d/MeshScene.tsx

import { Canvas } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"

function MeshScene({ meshData }: { meshData: MeshData }) {
  const { structures, structureVisibility } = useViewerStore()
  const geometries = useMemo(() => splitByLabel(meshData), [meshData])

  return (
    <Canvas camera={{ position: [0, 0, 150], fov: 50 }}>
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 10, 5]} intensity={0.8} />
      <directionalLight position={[-10, -10, -5]} intensity={0.3} />

      {geometries.map(({ label, geometry }) => (
        <BoneMesh
          key={label}
          geometry={geometry}
          color={structures.find(s => s.label === label)?.color ?? "#888"}
          visible={structureVisibility[label] ?? true}
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

### Per-Label Mesh Splitting

Split the full mesh into separate `BufferGeometry` instances per label for independent rendering and toggling:

```typescript
import * as THREE from "three"

interface LabelGeometry {
  label: number
  geometry: THREE.BufferGeometry
}

function splitByLabel(meshData: MeshData): LabelGeometry[] {
  const labelSet = new Set(meshData.labels)
  const result: LabelGeometry[] = []

  for (const label of labelSet) {
    if (label === 0) continue // Skip unlabeled

    // Find faces where all 3 vertices have this label
    const facesForLabel: number[] = []
    for (let i = 0; i < meshData.faceCount; i++) {
      const v0 = meshData.faces[i * 3]
      const v1 = meshData.faces[i * 3 + 1]
      const v2 = meshData.faces[i * 3 + 2]
      if (
        meshData.labels[v0] === label &&
        meshData.labels[v1] === label &&
        meshData.labels[v2] === label
      ) {
        facesForLabel.push(v0, v1, v2)
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(meshData.vertices, 3)
    )
    geometry.setIndex(facesForLabel)
    geometry.computeVertexNormals()

    result.push({ label, geometry })
  }

  return result
}
```

## BoneMesh Component

```tsx
// features/viewer-3d/BoneMesh.tsx

function BoneMesh({
  geometry,
  color,
  visible,
}: {
  geometry: THREE.BufferGeometry
  color: string
  visible: boolean
}) {
  if (!visible) return null

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={color}
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

function Viewer3DPanel({ meshId }: { meshId: string }) {
  const meshData = useViewerStore((s) => s.meshData)

  if (!meshData || meshData.meshId !== meshId) {
    return <ViewerEmptyState />
  }

  return (
    <div className="relative h-full">
      <ViewerToolbar meshId={meshId} />
      <MeshScene meshData={meshData} />
      <StructureToggle />
    </div>
  )
}
```

## StructureToggle

Overlaid on the canvas, shows checkboxes for each bone structure:

```tsx
// features/viewer-3d/StructureToggle.tsx

import { Checkbox } from "@/components/ui/checkbox"
import { useViewerStore } from "@/stores/viewer-store"

function StructureToggle() {
  const { structures, structureVisibility, toggleStructure } = useViewerStore()

  if (structures.length === 0) return null

  return (
    <div className="absolute right-4 top-4 rounded-lg border bg-background/90 p-3 backdrop-blur">
      <h4 className="mb-2 text-sm font-medium">Structures</h4>
      {structures.map((s) => (
        <label key={s.label} className="flex items-center gap-2 py-1">
          <Checkbox
            checked={structureVisibility[s.label] ?? true}
            onCheckedChange={() => toggleStructure(s.label)}
          />
          <div
            className="h-3 w-3 rounded-full"
            style={{ background: s.color }}
          />
          <span className="text-sm">{s.name}</span>
        </label>
      ))}
    </div>
  )
}
```

## ViewerToolbar

Actions for the 3D viewer:

```tsx
// features/viewer-3d/ViewerToolbar.tsx

function ViewerToolbar({ meshId }: { meshId: string }) {
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

- **Screenshot**: Captures canvas as PNG via `canvas.toDataURL()`
- **Reset View**: Returns camera to default position
- **Export STL**: Downloads mesh as STL file (uses trimesh in the sandbox)

## Interactions

| Action | Behavior |
|--------|----------|
| Left drag | Rotate (OrbitControls) |
| Scroll | Zoom |
| Right drag / Shift+left | Pan |
| Reset button | Camera returns to default |
| Structure checkbox | Toggle bone visibility |
| Export STL | Download mesh file |
| Screenshot | Save canvas as PNG |

## Performance

Expected mesh sizes from the imaging pipeline:
- Per-bone: ~10K-50K vertices, ~20K-100K faces
- Total scene: ~50K-200K vertices

React Three Fiber handles this easily. Optimizations:
- `BufferGeometry` with pre-computed indices (not indexed geometry conversion)
- Vertex normals computed once on load, not per frame
- Labels are static — no per-frame label checks
- `splitByLabel` memoized on meshData reference

## Dependencies

```
@react-three/fiber        # React renderer for Three.js
@react-three/drei         # Helpers (OrbitControls, etc.)
three                     # Three.js core
```

## Storybook

`Viewer3DPanel.stories.tsx` uses a mock mesh from `examples/mock-mesh.ts`:
- Simple cube mesh (test geometry correctness)
- Multi-label mesh (test color coding + structure toggle)
- Large mesh (performance test with 100K vertices)

Mock data uses pre-built `Float32Array`/`Uint32Array` without binary parsing.

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

- The persisted `display_result` turn block with `mesh_ref` metadata still exists, so MeshRefBlock renders in the chat.
- The viewer store has no mesh data (binary was in-memory only).
- Clicking "View 3D" on MeshRefBlock checks `viewerStore.meshData` — if null for that meshId, MeshRefBlock shows a disabled state: "3D data not loaded — ask the agent to regenerate the model."
- The 3D Viewer tab in ContentToolbar is hidden when `viewerMeshId` is null.

**Deferred**: Re-fetching mesh data from a running sandbox or persisting mesh binary to storage. For MVP, the researcher re-runs the segmentation (which is fast after initial processing) or continues in the same session.

## Related Docs

- [Layout](layout.md) — content panel hosting the viewer
- [State Management](state.md) — viewer store, WS binary frame wiring
- [Activity Stream](activity-stream.md) — DISPLAY_RESULT creates MeshRefBlock
- [Inline Results](inline-results.md) — MeshRefBlock triggers viewer
- [Display Result Pipeline (backend)](../backend/display-results.md) — binary mesh frame protocol
