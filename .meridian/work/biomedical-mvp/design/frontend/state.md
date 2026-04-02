# State Management

Zustand stores for the biomedical MVP. This is v2's Phase 7 (data integration), scoped to what the biomedical workflow needs. See [overview](overview.md) for how stores fit into the frontend architecture.

## Store Inventory

| Store | Purpose | Scope |
|-------|---------|-------|
| `useWorkspaceStore` | Panel state, active content, active project/thread | Singleton |
| `useDatasetStore` | Dataset list, upload state per project | Per-project |
| `useViewerStore` | Mesh data, viewer visibility, structure state | Singleton |

The **thread streaming state** is already handled by the existing `StreamingChannelClient` + `useThreadStreaming` hook in `src/features/threads/streaming/`. No new store needed for streaming — the reducer-based approach already works.

## Workspace Store

Controls what the user sees — which project, which thread, what's in the right panel.

```typescript
// stores/workspace-store.ts

import { create } from "zustand"

type ContentView =
  | { type: "empty" }
  | { type: "viewer"; meshId: string }
  | { type: "datasets"; projectId: string }
  | { type: "editor"; documentId?: string }

interface WorkspaceState {
  // Active context
  activeProjectId: string | null
  activeThreadId: string | null

  // Right panel
  activeContent: ContentView

  // Actions
  setActiveProject: (projectId: string) => void
  setActiveThread: (threadId: string) => void
  setActiveContent: (content: ContentView) => void

  // Convenience: switch to viewer when mesh arrives
  showViewer: (meshId: string) => void
  // Convenience: switch to datasets
  showDatasets: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  activeProjectId: null,
  activeThreadId: null,
  activeContent: { type: "empty" },

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
}))
```

## Dataset Store

Manages dataset state for the active project. Uses TanStack Query for server state (list, metadata) and zustand for client state (upload progress).

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

  // Actions
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
        status: "uploading",
        datasetId,
        filesUploaded: 0,
        totalFiles,
        bytesUploaded: 0,
        totalBytes,
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
  setError: (message) =>
    set({ upload: { status: "error", message } }),
  resetUpload: () =>
    set({ upload: { status: "idle" } }),
}))
```

**Server state (TanStack Query)** handles dataset list and metadata:

```typescript
// features/datasets/hooks/useDatasets.ts

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"

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

export function useFinalizeDataset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (datasetId: string) => finalizeDataset(datasetId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["projects", data.projectId, "datasets"],
      })
    },
  })
}
```

## Viewer Store

Manages 3D viewer state — mesh data received from WS binary frames, structure visibility, camera state.

```typescript
// stores/viewer-store.ts

import { create } from "zustand"
import type { MeshData, BoneStructure } from "@/features/viewer-3d/types"

interface ViewerState {
  // Mesh data from binary WS frame
  meshData: MeshData | null
  activeMeshId: string | null

  // Per-structure visibility
  structures: BoneStructure[]
  structureVisibility: Record<number, boolean>  // label → visible

  // Actions
  setMeshData: (meshId: string, data: MeshData) => void
  clearMesh: () => void
  toggleStructure: (label: number) => void
  setAllStructuresVisible: (visible: boolean) => void
}

export const useViewerStore = create<ViewerState>((set) => ({
  meshData: null,
  activeMeshId: null,
  structures: [],
  structureVisibility: {},

  setMeshData: (meshId, data) => {
    // Build structures from mesh label data
    const labelSet = new Set(Array.from(data.labels))
    const structures: BoneStructure[] = []
    const visibility: Record<number, boolean> = {}

    for (const label of labelSet) {
      if (label === 0) continue  // Skip unlabeled
      structures.push({
        label,
        name: data.labelNames[label] ?? `Structure ${label}`,
        color: BONE_COLORS[data.labelNames[label]] ?? "#888888",
      })
      visibility[label] = true
    }

    set({
      meshData: data,
      activeMeshId: meshId,
      structures,
      structureVisibility: visibility,
    })
  },

  clearMesh: () =>
    set({
      meshData: null,
      activeMeshId: null,
      structures: [],
      structureVisibility: {},
    }),

  toggleStructure: (label) =>
    set((state) => ({
      structureVisibility: {
        ...state.structureVisibility,
        [label]: !state.structureVisibility[label],
      },
    })),

  setAllStructuresVisible: (visible) =>
    set((state) => {
      const visibility: Record<number, boolean> = {}
      for (const label of Object.keys(state.structureVisibility)) {
        visibility[Number(label)] = visible
      }
      return { structureVisibility: visibility }
    }),
}))

const BONE_COLORS: Record<string, string> = {
  femur: "#4488ff",
  tibia: "#44cc66",
  patella: "#9966cc",
  osteophyte: "#ff4444",
}
```

## WS Binary Frame → Viewer Store Wiring

The `ThreadWsProvider` (existing) receives binary frames via `WsClient.onBinaryMessage`. We add a handler that parses mesh frames and updates the viewer store + triggers content panel switch:

```typescript
// In ThreadWsProvider setup:

const handleBinaryMessage = (subId: string, payload: Uint8Array) => {
  // Parse mesh binary frame
  const meshData = parseMeshBinary(payload)
  if (!meshData) return

  // Update viewer store
  useViewerStore.getState().setMeshData(meshData.meshId, meshData)

  // Auto-switch content panel to viewer
  useWorkspaceStore.getState().showViewer(meshData.meshId)
}

// Wire into WsClient config:
const client = new WsClient({
  // ...existing config...
  onBinaryMessage: handleBinaryMessage,
})
```

See [viewer-3d.md](viewer-3d.md) for the `parseMeshBinary` function.

## API Client

A thin fetch wrapper for dataset endpoints. Follows the pattern used by v1 for authenticated API calls:

```typescript
// lib/api.ts

const API_BASE = import.meta.env.VITE_API_URL ?? ""

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken()  // From auth provider
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  })
  if (!res.ok) {
    throw new ApiError(res.status, await res.text())
  }
  return res.json()
}

// Dataset API
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

Authentication is not yet built in v2 (Phase 8). For the biomedical MVP:

1. **Dev mode**: Use a hardcoded JWT from `scripts/get-token.sh` (same as v1 dev)
2. **Prod**: Supabase Auth integration (same as v1) — minimal wrapper

The auth token is needed for:
- API requests (`Authorization: Bearer` header)
- WS connection (`auth` control message — already supported by WsClient)
- Supabase Storage uploads (direct upload with auth token)

## Related Docs

- [Layout](layout.md) — workspace store drives panel switching
- [Dataset Upload](dataset-upload.md) — uses dataset store + TanStack Query hooks
- [3D Viewer](viewer-3d.md) — uses viewer store for mesh data
- [Activity Stream Extensions](activity-stream-extensions.md) — PYTHON_RESULT triggers workspace store
