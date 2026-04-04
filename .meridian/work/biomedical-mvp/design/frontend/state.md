# State Management

Zustand stores for the biomedical MVP. See [overview](overview.md) for how stores fit into the frontend architecture.

## Store Inventory

| Store | Purpose | Scope |
|-------|---------|-------|
| `useWorkspaceStore` | Panel state, active content, active project/thread | Singleton |
| `useDatasetStore` | Dataset list, upload state per project | Per-project |
| `useViewerStore` | Multi-mesh scene, per-mesh visibility | Singleton |

Thread streaming state is handled by the existing `StreamingChannelClient` + `useThreadStreaming` hook.

## Workspace Store

Controls what the user sees — which project, which thread, what's in the right panel.

```typescript
// stores/workspace-store.ts

import { create } from "zustand"

type ContentView =
  | { type: "empty" }
  | { type: "viewer"; meshId?: string }
  | { type: "datasets"; projectId: string }
  | { type: "editor"; documentId?: string }

interface WorkspaceState {
  activeProjectId: string | null
  activeThreadId: string | null
  activeContent: ContentView
  /** True when any mesh exists in the viewer store */
  hasViewerContent: boolean

  setActiveProject: (projectId: string) => void
  setActiveThread: (threadId: string) => void
  setActiveContent: (content: ContentView) => void
  showViewer: (meshId?: string) => void
  showDatasets: () => void
  setHasViewerContent: (has: boolean) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  activeProjectId: null,
  activeThreadId: null,
  activeContent: { type: "empty" },
  hasViewerContent: false,

  setActiveProject: (projectId) =>
    set({ activeProjectId: projectId, activeContent: { type: "datasets", projectId } }),
  setActiveThread: (threadId) =>
    set({ activeThreadId: threadId }),
  setActiveContent: (content) =>
    set({ activeContent: content }),

  showViewer: (meshId) =>
    set({ activeContent: { type: "viewer", meshId } }),
  showDatasets: () => {
    const projectId = get().activeProjectId
    if (projectId) {
      set({ activeContent: { type: "datasets", projectId } })
    }
  },
  setHasViewerContent: (has) =>
    set({ hasViewerContent: has }),
}))
```

## Dataset Store

Manages upload state. Server state (list, metadata) uses TanStack Query.

```typescript
// stores/dataset-store.ts

import { create } from "zustand"

type UploadState =
  | { status: "idle" }
  | {
      status: "uploading"
      datasetId: string
      filesUploaded: number
      totalFiles: number
      bytesUploaded: number
      totalBytes: number
    }
  | { status: "processing"; datasetId: string }
  | { status: "complete"; datasetId: string }
  | { status: "error"; message: string }

interface DatasetState {
  upload: UploadState
  startUpload: (datasetId: string, totalFiles: number, totalBytes: number) => void
  updateProgress: (filesUploaded: number, bytesUploaded: number) => void
  setProcessing: () => void
  setComplete: () => void
  setError: (message: string) => void
  resetUpload: () => void
}

export const useDatasetStore = create<DatasetState>((set, get) => ({
  upload: { status: "idle" },

  startUpload: (datasetId, totalFiles, totalBytes) =>
    set({
      upload: {
        status: "uploading", datasetId,
        filesUploaded: 0, totalFiles,
        bytesUploaded: 0, totalBytes,
      },
    }),
  updateProgress: (filesUploaded, bytesUploaded) =>
    set((state) => {
      if (state.upload.status !== "uploading") return state
      return { upload: { ...state.upload, filesUploaded, bytesUploaded } }
    }),
  setProcessing: () =>
    set((state) => {
      if (state.upload.status !== "uploading") return state
      return { upload: { status: "processing", datasetId: state.upload.datasetId } }
    }),
  setComplete: () =>
    set((state) => {
      if (state.upload.status !== "processing") return state
      return { upload: { status: "complete", datasetId: state.upload.datasetId } }
    }),
  setError: (message) => set({ upload: { status: "error", message } }),
  resetUpload: () => set({ upload: { status: "idle" } }),
}))
```

**Server state (TanStack Query)** handles dataset list and metadata:

```typescript
// features/datasets/hooks/useDatasets.ts

export function useDatasets(projectId: string) {
  return useQuery({
    queryKey: ["projects", projectId, "datasets"],
    queryFn: () => fetchDatasets(projectId),
    enabled: !!projectId,
  })
}

export function useCreateDataset(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (params: { name: string; slug: string }) =>
      createDataset(projectId, params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "datasets"] })
    },
  })
}
```

## Viewer Store

Manages the multi-mesh 3D scene. Each mesh is stored by its AI-chosen ID. Same ID replaces, new ID adds.

```typescript
// stores/viewer-store.ts

import { create } from "zustand"
import type { MeshData } from "@/features/viewer-3d/types"

interface ViewerState {
  /** All meshes in the scene, keyed by mesh_id */
  meshes: Record<string, MeshData>
  /** Per-mesh visibility (true = visible) */
  meshVisibility: Record<string, boolean>

  /** Pending metadata from DISPLAY_RESULT, keyed by mesh_id. Stored until binary arrives. */
  pendingMeshMeta: Record<string, { label: string; color: string; vertexCount: number; faceCount: number }>
  /** Pending binary data that arrived before its DISPLAY_RESULT metadata. */
  pendingMeshBinary: Record<string, { vertices: Float32Array; faces: Uint32Array; vertexCount: number; faceCount: number }>

  // Actions
  setPendingMeta: (meshId: string, meta: { label: string; color: string; vertexCount: number; faceCount: number }) => void
  receiveBinaryMesh: (meshId: string, binary: { vertices: Float32Array; faces: Uint32Array; vertexCount: number; faceCount: number }) => void
  clearAllMeshes: () => void
  removeMesh: (meshId: string) => void
  toggleMesh: (meshId: string) => void
  setAllMeshesVisible: (visible: boolean) => void
}

export const useViewerStore = create<ViewerState>((set) => ({
  meshes: {},
  meshVisibility: {},
  pendingMeshMeta: {},
  pendingMeshBinary: {},

  // Called when DISPLAY_RESULT with mesh_ref arrives (SSE)
  setPendingMeta: (meshId, meta) =>
    set((state) => {
      // Check if binary data already arrived (binary-before-metadata race)
      const pendingBinary = state.pendingMeshBinary[meshId]
      if (pendingBinary) {
        const { [meshId]: _, ...remainingBinary } = state.pendingMeshBinary
        const meshData: MeshData = {
          meshId,
          vertices: pendingBinary.vertices,
          faces: pendingBinary.faces,
          vertexCount: pendingBinary.vertexCount,
          faceCount: pendingBinary.faceCount,
          label: meta.label,
          color: meta.color,
        }
        return {
          meshes: { ...state.meshes, [meshId]: meshData },
          meshVisibility: { ...state.meshVisibility, [meshId]: true },
          pendingMeshBinary: remainingBinary,
        }
      }
      // Normal path: store metadata, wait for binary
      return {
        pendingMeshMeta: { ...state.pendingMeshMeta, [meshId]: meta },
      }
    }),

  // Called when WS binary frame arrives
  receiveBinaryMesh: (meshId, binary) =>
    set((state) => {
      const meta = state.pendingMeshMeta[meshId]
      if (meta === undefined) {
        // Metadata hasn't arrived yet — store binary data, wait for DISPLAY_RESULT
        return {
          pendingMeshBinary: { ...state.pendingMeshBinary, [meshId]: binary },
        }
      }
      // Normal path: metadata already stored, merge now
      const { [meshId]: _, ...remainingMeta } = state.pendingMeshMeta
      const meshData: MeshData = {
        meshId,
        vertices: binary.vertices,
        faces: binary.faces,
        vertexCount: binary.vertexCount,
        faceCount: binary.faceCount,
        label: meta.label,
        color: meta.color,
      }
      return {
        meshes: { ...state.meshes, [meshId]: meshData },
        meshVisibility: { ...state.meshVisibility, [meshId]: true },
        pendingMeshMeta: remainingMeta,
      }
    }),

  clearAllMeshes: () =>
    set({ meshes: {}, meshVisibility: {}, pendingMeshMeta: {}, pendingMeshBinary: {} }),

  removeMesh: (meshId) =>
    set((state) => {
      const { [meshId]: _, ...remainingMeshes } = state.meshes
      const { [meshId]: __, ...remainingVis } = state.meshVisibility
      return { meshes: remainingMeshes, meshVisibility: remainingVis }
    }),

  toggleMesh: (meshId) =>
    set((state) => ({
      meshVisibility: {
        ...state.meshVisibility,
        [meshId]: !(state.meshVisibility[meshId] ?? true),
      },
    })),

  setAllMeshesVisible: (visible) =>
    set((state) => {
      const visibility: Record<string, boolean> = {}
      for (const id of Object.keys(state.meshes)) {
        visibility[id] = visible
      }
      return { meshVisibility: visibility }
    }),
}))
```

**Key changes from previous design**:
- `meshes` is a `Record<string, MeshData>` — multiple meshes by ID, not a single `meshData` field
- No `structures` array or `structureVisibility` by numeric label — each mesh IS a structure
- `pendingMeshMeta` holds `label` + `color` from DISPLAY_RESULT (not `labelNames` map)
- Same `mesh_id` replaces an existing mesh (e.g. re-running segmentation)

## Mesh Metadata/Binary Join

Mesh data arrives in two messages over separate transports (SSE + WS) with **no cross-transport ordering guarantee**:
1. `DISPLAY_RESULT` with `resultType: "mesh_ref"` — metadata: label, color, counts (SSE)
2. WS binary frame — geometry: vertices, faces

The viewer store handles both orderings via symmetric pending:
- **Metadata first (normal)**: `setPendingMeta()` stores label/color → `receiveBinaryMesh()` finds metadata, merges immediately
- **Binary first (race)**: `receiveBinaryMesh()` stores data in `pendingMeshBinary` → `setPendingMeta()` finds pending data, merges immediately

Either way, the mesh appears in `meshes` exactly once, fully formed.

## WS Binary Frame Dispatch

`WsClient.onBinaryMessage` is a **single callback** (one consumer). Both Yjs document sync (`DocWsProvider`) and mesh binary data need binary frames. A dispatch layer routes frames by `subId`:

- **Yjs frames** use `docId` as subId (registered by `DocWsProvider`)
- **Mesh frames** use `toolCallId` as subId (deterministic AG-UI format, e.g. `call_abc123`)

```typescript
// lib/ws/binary-dispatch.ts

type BinaryHandler = (subId: string, data: Uint8Array) => void

class BinaryDispatch {
  private docSubscriptions = new Set<string>()
  private docHandler: BinaryHandler | null = null
  private meshHandler: BinaryHandler | null = null

  registerDoc(docId: string, handler: BinaryHandler) {
    this.docSubscriptions.add(docId)
    this.docHandler = handler
  }

  unregisterDoc(docId: string) {
    this.docSubscriptions.delete(docId)
  }

  registerMesh(handler: BinaryHandler) {
    this.meshHandler = handler
  }

  dispatch(subId: string, data: Uint8Array) {
    if (this.docSubscriptions.has(subId)) {
      this.docHandler?.(subId, data)
    } else {
      this.meshHandler?.(subId, data)
    }
  }
}

export const binaryDispatch = new BinaryDispatch()
```

`ThreadWsProvider` registers the mesh handler:

```typescript
// In ThreadWsProvider setup:
binaryDispatch.registerMesh((subId: string, payload: Uint8Array) => {
  const parsed = parseMeshBinary(payload)
  if (!parsed) return

  useViewerStore.getState().receiveBinaryMesh(parsed.meshId, {
    vertices: parsed.vertices,
    faces: parsed.faces,
    vertexCount: parsed.vertexCount,
    faceCount: parsed.faceCount,
  })
  useWorkspaceStore.getState().showViewer(parsed.meshId)
  useWorkspaceStore.getState().setHasViewerContent(true)
})
```

The DISPLAY_RESULT handler calls `setPendingMeta`:

```typescript
// When DISPLAY_RESULT with mesh_ref arrives:
if (event.data.resultType === "mesh_ref") {
  useViewerStore.getState().setPendingMeta(event.data.mesh_id, {
    label: event.data.label,
    color: event.data.color,
    vertexCount: event.data.vertex_count,
    faceCount: event.data.face_count,
  })
}
```

## API Client

Thin fetch wrapper for dataset endpoints:

```typescript
// lib/api.ts

const API_BASE = import.meta.env.VITE_API_URL ?? ""

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken()
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return res.json()
}

export const datasetApi = {
  list: (projectId: string) =>
    apiFetch<Dataset[]>(`/api/projects/${projectId}/datasets`),
  create: (projectId: string, params: { name: string; slug: string }) =>
    apiFetch<{ id: string; slug: string; upload_url: string }>(
      `/api/projects/${projectId}/datasets`,
      { method: "POST", body: JSON.stringify(params) }
    ),
  finalize: (datasetId: string) =>
    apiFetch<Dataset>(`/api/datasets/${datasetId}/finalize`, { method: "POST" }),
  delete: (datasetId: string) =>
    apiFetch<void>(`/api/datasets/${datasetId}`, { method: "DELETE" }),
}
```

## Auth Integration

Single token provider used across all auth surfaces:

```typescript
// lib/auth.ts

let cachedToken: string | null = null

export async function getAuthToken(): Promise<string> {
  if (cachedToken) return cachedToken
  const envToken = import.meta.env.VITE_AUTH_TOKEN
  if (envToken) { cachedToken = envToken; return envToken }
  throw new Error("No auth token available. Set VITE_AUTH_TOKEN for dev mode.")
}
```

**Auth surfaces** — all use `getAuthToken()`:

| Surface | How | Where |
|---------|-----|-------|
| **API requests** | `Authorization: Bearer` header | `lib/api.ts` -> `apiFetch()` |
| **WebSocket** | `getToken` callback in WsClient config | `ThreadWsProvider.tsx` -> `new WsClient({ getToken: getAuthToken })` |
| **Supabase Storage uploads** | `Authorization: Bearer` header on PUT | `useDatasetUpload.ts` -> direct fetch to pre-signed URL with token |

1. **Dev mode**: `VITE_AUTH_TOKEN` env var from `scripts/get-token.sh` output
2. **Prod**: Replace `getAuthToken()` body with Supabase Auth session token (deferred)

## Related Docs

- [Layout](layout.md) — workspace store drives panel switching
- [Dataset Upload](dataset-upload.md) — uses dataset store + TanStack Query hooks
- [3D Viewer](viewer-3d.md) — uses viewer store for multi-mesh scene
- [Activity Stream](activity-stream.md) — DISPLAY_RESULT triggers workspace store
