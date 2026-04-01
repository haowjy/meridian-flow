# 3D Viewer Component

React Three Fiber canvas for visualizing segmented bone meshes. Lives in the right panel alongside the existing editor. See [overview](../overview.md) for system context.

## Placement in Layout

The existing `DocumentPanel` switches content based on state (editor, skill editor, project home). The 3D viewer becomes a new content type:

```
Right Panel (DocumentPanel)
├── activeDocumentId → EditorPanel (existing)
├── activeSkillId → SkillEditorPanel (existing)
├── activeMeshId → Viewer3DPanel (NEW)
├── /skills/new → SkillCreatePanel (existing)
└── default → ProjectHomeView (existing)
```

The viewer activates when a `PYTHON_RESULT` event with `resultType: "mesh_ref"` arrives. The UI store gains a new field:

```typescript
// In useUIStore
activeMeshId: string | null    // Set when mesh data arrives
meshData: MeshData | null      // Binary mesh data
```

## Component Architecture

```
features/viewer-3d/
├── Viewer3DPanel.tsx           # Panel wrapper (toolbar + canvas)
├── MeshScene.tsx               # Three.js scene with camera, lights, meshes
├── BoneMesh.tsx                # Individual mesh component per label
├── ViewerControls.tsx          # Orbit controls + reset camera
├── StructureToggle.tsx         # Toggle visibility per bone structure
├── ViewerToolbar.tsx           # Export, screenshot, reset buttons
├── hooks/
│   ├── useMeshData.ts          # Parses binary mesh data into Three.js geometries
│   └── useViewerState.ts       # Local viewer state (visibility, camera position)
└── types.ts                    # MeshData, BoneStructure types
```

## Data Types

```typescript
// features/viewer-3d/types.ts

interface MeshData {
  meshId: string
  vertices: Float32Array      // [x,y,z, x,y,z, ...] flat
  faces: Uint32Array          // [v0,v1,v2, v0,v1,v2, ...] flat
  labels: Uint8Array          // Per-vertex label (0 = unlabeled)
  vertexCount: number
  faceCount: number
  labelNames: Record<number, string>  // e.g., {1: "femur", 2: "tibia"}
}

interface BoneStructure {
  label: number
  name: string
  color: string
  visible: boolean
}

// Default color map per requirements
const BONE_COLORS: Record<string, string> = {
  femur: '#4488ff',      // Blue
  tibia: '#44cc66',      // Green
  patella: '#9966cc',    // Purple
  osteophyte: '#ff4444', // Red
}
```

## Binary Data Reception

The existing `WsClient.onBinaryMessage` callback receives mesh binary frames. A new handler parses the frame:

```typescript
// features/viewer-3d/hooks/useMeshData.ts

function parseMeshBinary(data: Uint8Array): MeshData {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0

  // Find mesh_id (null-terminated UTF-8 string)
  const nullIdx = data.indexOf(0x00)
  const meshId = new TextDecoder().decode(data.slice(0, nullIdx))
  offset = nullIdx + 1

  const vertexCount = view.getUint32(offset, true); offset += 4
  const faceCount = view.getUint32(offset, true); offset += 4

  const vertexBytes = vertexCount * 3 * 4  // float32 x,y,z
  const vertices = new Float32Array(data.buffer, data.byteOffset + offset, vertexCount * 3)
  offset += vertexBytes

  const faceBytes = faceCount * 3 * 4  // uint32 v0,v1,v2
  const faces = new Uint32Array(data.buffer, data.byteOffset + offset, faceCount * 3)
  offset += faceBytes

  const labels = new Uint8Array(data.buffer, data.byteOffset + offset, vertexCount)

  return { meshId, vertices, faces, labels, vertexCount, faceCount, labelNames: {} }
}
```

## Scene Setup

```tsx
// features/viewer-3d/MeshScene.tsx

function MeshScene({ meshData }: { meshData: MeshData }) {
  const structures = useMemo(() => splitByLabel(meshData), [meshData])

  return (
    <Canvas camera={{ position: [0, 0, 150], fov: 50 }}>
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 10, 5]} intensity={0.8} />
      <directionalLight position={[-10, -10, -5]} intensity={0.3} />

      {structures.map(structure => (
        <BoneMesh
          key={structure.label}
          structure={structure}
        />
      ))}

      <OrbitControls
        enableDamping
        dampingFactor={0.1}
        rotateSpeed={0.8}
        zoomSpeed={1.2}
      />
      <gridHelper args={[100, 10]} />
    </Canvas>
  )
}
```

### Per-Label Mesh Splitting

The full mesh arrives with per-vertex labels. We split it into separate `BufferGeometry` instances per label for independent rendering and toggling:

```typescript
function splitByLabel(meshData: MeshData): BoneStructure[] {
  const labelSet = new Set(meshData.labels)
  const structures: BoneStructure[] = []

  for (const label of labelSet) {
    if (label === 0) continue // Skip unlabeled

    // Find faces where all 3 vertices have this label
    const facesForLabel: number[] = []
    for (let i = 0; i < meshData.faceCount; i++) {
      const v0 = meshData.faces[i * 3]
      const v1 = meshData.faces[i * 3 + 1]
      const v2 = meshData.faces[i * 3 + 2]
      if (meshData.labels[v0] === label &&
          meshData.labels[v1] === label &&
          meshData.labels[v2] === label) {
        facesForLabel.push(v0, v1, v2)
      }
    }

    // Build BufferGeometry for this label
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position',
      new THREE.Float32BufferAttribute(meshData.vertices, 3))
    geometry.setIndex(facesForLabel)
    geometry.computeVertexNormals()

    structures.push({
      label,
      name: meshData.labelNames[label] || `Structure ${label}`,
      color: BONE_COLORS[meshData.labelNames[label]] || '#888888',
      visible: true,
      geometry,
    })
  }

  return structures
}
```

## Interactions

### Camera Controls
- **Rotate**: Left mouse drag (OrbitControls)
- **Zoom**: Scroll wheel
- **Pan**: Right mouse drag or Shift + left drag
- **Reset**: Button in toolbar resets to default view

### Structure Toggle
Sidebar panel with checkboxes per bone structure:

```tsx
// features/viewer-3d/StructureToggle.tsx
function StructureToggle({ structures, onToggle }) {
  return (
    <div className="absolute top-4 right-4 bg-background/90 backdrop-blur p-3 rounded-lg border">
      <h4 className="text-sm font-medium mb-2">Structures</h4>
      {structures.map(s => (
        <label key={s.label} className="flex items-center gap-2 py-1">
          <Checkbox checked={s.visible} onCheckedChange={() => onToggle(s.label)} />
          <div className="w-3 h-3 rounded-full" style={{ background: s.color }} />
          <span className="text-sm">{s.name}</span>
        </label>
      ))}
    </div>
  )
}
```

### Toolbar Actions
- **Export STL**: Downloads the mesh as STL file (via sandbox file export)
- **Screenshot**: Captures canvas as PNG
- **Reset View**: Returns camera to default position
- **Close**: Returns to document panel

## Performance

Expected mesh sizes from the imaging pipeline:
- Per-bone: ~10K-50K vertices, ~20K-100K faces
- Total scene: ~50K-200K vertices

React Three Fiber handles this easily. For larger meshes:
- Use `THREE.BufferGeometry` (not indexed geometry conversion)
- Vertex normals computed once on load, not per frame
- Labels are static — no per-frame label checks

## Dependencies

```
@react-three/fiber        # React renderer for Three.js
@react-three/drei         # Helpers (OrbitControls, Grid, etc.)
three                     # Three.js core
```

## Sandbox Stopped State

When the user reloads and the sandbox is stopped, the viewer shows:

```tsx
<div className="flex flex-col items-center justify-center h-full text-muted-foreground">
  <CubeIcon className="w-12 h-12 mb-4" />
  <p>3D viewer data is from a previous session</p>
  <p className="text-sm">Resume the sandbox to interact with the model</p>
  <Button variant="outline" onClick={resumeSandbox}>Resume</Button>
</div>
```

## Related Docs

- [Stream Extensions](../backend/stream-extensions.md) — mesh_ref event + binary frame protocol
- [Inline Results](inline-results.md) — other result types rendered in chat
- [Overview](../overview.md) — how the viewer fits in the two-panel layout
