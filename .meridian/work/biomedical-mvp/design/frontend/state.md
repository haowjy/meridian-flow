# State Management

Zustand stores for the biomedical MVP. See [overview](overview.md) for how stores fit into the frontend architecture.

**Revised from previous design**: Updated event names (`DISPLAY_RESULT` instead of `PYTHON_RESULT`), viewer store uses generic display result for mesh metadata, workspace store contracts clarified.

## Store Inventory

| Store | Purpose | Scope |
|-------|---------|-------|
| `useWorkspaceStore` | Panel state, active content, active project/thread | Singleton |
| `useDatasetStore` | Dataset list, upload state per project | Per-project |
| `useViewerStore` | Mesh data, viewer visibility, structure state | Singleton |

Thread streaming state is handled by the existing `StreamingChannelClient` + `useThreadStreaming` hook.

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
  /** Track last mesh ID for ContentToolbar tab visibility */
  viewerMeshId: string | null

  // Actions
  setActiveProject: (projectId: string) => void
  setActiveThread: (threadId: string) => void
  setActiveContent: (content: ContentView) => void
  showViewer: (meshId: string) => void
  showDatasets: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  activeProjectId: null,
  activeThreadId: null,
  activeContent: { type: "empty" },
  viewerMeshId: null,

  setActiveProject: (projectId) =>
    set({ activeProjectId: projectId, activeContent: { type: "datasets", projectId } }),
  setActiveThread: (threadId) =>
    set({ activeThreadId: threadId }),
  setActiveContent: (content) =>
    set({ activeContent: content }),

  showViewer: (meshId) =>
    set({ activeContent: { type: "viewer", meshId }, viewerMeshId: meshId }),
  showDatasets: () => {
    const projectId = get().activeProjectId
    if (projectId) {
      set({ activeContent: { type: "datasets", projectId } })
    }
  },
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

Manages 3D viewer state — mesh data from WS binary frames, structure visibility.

```typescript
// stores/viewer-store.ts

import { create } from "zustand"
import type { MeshData, BoneStructure } from "@/features/viewer-3d/types"
import { BONE_COLORS } from "@/features/viewer-3d/constants"

interface ViewerState {
  // Mesh data from binary WS frame
  meshData: MeshData | null
  activeMeshId: string | null

  // Per-structure visibility
  structures: BoneStructure[]
  structureVisibility: Record<number, boolean>

  /** Label names from DISPLAY_RESULT, keyed by mesh_id. Stored until binary arrives. */
  pendingMeshLabels: Record<string, Record<string, string>>
  /** Binary mesh data that arrived before its DISPLAY_RESULT labels. */
  pendingMeshData: Record<string, MeshData>

  // Actions
  setPendingLabels: (meshId: string, labelNames: Record<string, string>) => void
  receiveBinaryMesh: (meshId: string, data: MeshData) => void
  clearMesh: () => void
  toggleStructure: (label: number) => void
  setAllStructuresVisible: (visible: boolean) => void
}

/** Merge binary mesh data with label names into final viewer state. */
function buildMeshState(
  state: ViewerState,
  meshId: string,
  data: MeshData,
  labelNames: Record<string, string>,
  pendingMeshData: Record<string, MeshData>
) {
  const mergedData = { ...data, labelNames }
  const labelSet = new Set(Array.from(mergedData.labels))
  const structures: BoneStructure[] = []
  const visibility: Record<number, boolean> = {}
  for (const label of labelSet) {
    if (label === 0) continue
    const name = labelNames[String(label)] ?? `Structure ${label}`
    structures.push({ label, name, color: BONE_COLORS[name] ?? "#888888" })
    visibility[label] = true
  }
  const { [meshId]: _, ...remainingPending } = state.pendingMeshLabels
  return {
    meshData: mergedData,
    activeMeshId: meshId,
    structures,
    structureVisibility: visibility,
    pendingMeshLabels: remainingPending,
    pendingMeshData,
  }
}

export const useViewerStore = create<ViewerState>((set) => ({
  meshData: null,
  activeMeshId: null,
  structures: [],
  structureVisibility: {},
  pendingMeshLabels: {},
  pendingMeshData: {},

  // Called when DISPLAY_RESULT with mesh_ref arrives
  setPendingLabels: (meshId, labelNames) =>
    set((state) => {
      // Check if binary data already arrived (binary-before-labels race)
      const pendingData = state.pendingMeshData[meshId]
      if (pendingData) {
        // Binary arrived first — merge now
        const { [meshId]: _, ...remainingPendingData } = state.pendingMeshData
        return buildMeshState(state, meshId, pendingData, labelNames, remainingPendingData)
      }
      // Normal path: store labels, wait for binary
      return {
        pendingMeshLabels: { ...state.pendingMeshLabels, [meshId]: labelNames },
      }
    }),

  // Called when WS binary frame arrives — merges with pending labels
  receiveBinaryMesh: (meshId, data) =>
    set((state) => {
      const labelNames = state.pendingMeshLabels[meshId]
      if (labelNames === undefined) {
        // Labels haven't arrived yet — store binary data, wait for DISPLAY_RESULT
        return {
          pendingMeshData: { ...state.pendingMeshData, [meshId]: data },
        }
      }
      // Normal path: labels already stored, merge now
      return buildMeshState(state, meshId, data, labelNames, state.pendingMeshData)
    }),

  clearMesh: () =>
    set({ meshData: null, activeMeshId: null, structures: [], structureVisibility: {} }),

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
```

## Mesh Metadata/Binary Join

Mesh data arrives in two messages over separate transports (SSE + WS) with **no cross-transport ordering guarantee**:
1. `DISPLAY_RESULT` with `resultType: "mesh_ref"` — metadata + label names (SSE)
2. WS binary frame — geometry (vertices, faces, labels)

The viewer store handles both orderings via symmetric pending:
- **Labels first (normal)**: `setPendingLabels()` stores names → `receiveBinaryMesh()` finds labels, merges immediately
- **Binary first (race)**: `receiveBinaryMesh()` stores data in `pendingMeshData` → `setPendingLabels()` finds pending data, merges immediately

Either way, `buildMeshState()` runs exactly once per mesh, producing the final merged state.

## WS Binary Frame Dispatch

`WsClient.onBinaryMessage` is a **single callback** (one consumer). Both Yjs document sync (`DocWsProvider`) and mesh binary data need binary frames. A dispatch layer routes frames by `subId`:

- **Yjs frames** use `docId` as subId (registered by `DocWsProvider`)
- **Mesh frames** use `toolCallId` as subId (deterministic AG-UI format, e.g. `call_abc123`)

```typescript
// lib/ws/binary-dispatch.ts

type BinaryHandler = (subId: string, data: Uint8Array) => void

/** Routes WS binary frames to the correct consumer by subId. */
class BinaryDispatch {
  private docSubscriptions = new Set<string>()
  private docHandler: BinaryHandler | null = null
  private meshHandler: BinaryHandler | null = null

  /** Register a document subscription (called by DocWsProvider). */
  registerDoc(docId: string, handler: BinaryHandler) {
    this.docSubscriptions.add(docId)
    this.docHandler = handler
  }

  unregisterDoc(docId: string) {
    this.docSubscriptions.delete(docId)
  }

  /** Register the mesh handler (called by ThreadWsProvider). */
  registerMesh(handler: BinaryHandler) {
    this.meshHandler = handler
  }

  /** Route incoming binary frame. */
  dispatch(subId: string, data: Uint8Array) {
    if (this.docSubscriptions.has(subId)) {
      this.docHandler?.(subId, data)
    } else {
      // Default to mesh — mesh subIds are toolCallIds not registered as docs
      this.meshHandler?.(subId, data)
    }
  }
}

export const binaryDispatch = new BinaryDispatch()
```

`WsClient.onBinaryMessage` calls `binaryDispatch.dispatch()`. `DocWsProvider` registers doc subscriptions. `ThreadWsProvider` registers the mesh handler:

```typescript
// In ThreadWsProvider setup:
binaryDispatch.registerMesh((subId: string, payload: Uint8Array) => {
  const meshData = parseMeshBinary(payload)
  if (!meshData) return

  useViewerStore.getState().receiveBinaryMesh(meshData.meshId, meshData)
  useWorkspaceStore.getState().showViewer(meshData.meshId)
})

// In DocWsProvider setup:
binaryDispatch.registerDoc(docId, (subId, data) => {
  streamClient.handleBinaryMessage(subId, data)
})

// WsClient creation:
const client = new WsClient({
  // ...existing config...
  onBinaryMessage: (subId, data) => binaryDispatch.dispatch(subId, data),
})
```

The DISPLAY_RESULT handler calls `setPendingLabels`:

```typescript
// When DISPLAY_RESULT with mesh_ref arrives (reducer side effect or listener):
if (event.data.resultType === "mesh_ref") {
  useViewerStore.getState().setPendingLabels(
    event.data.mesh_id,
    event.data.label_names ?? {}
  )
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
// lib/auth.ts — shared auth token provider

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
| **API requests** | `Authorization: Bearer` header | `lib/api.ts` → `apiFetch()` |
| **WebSocket** | `getToken` callback in WsClient config | `ThreadWsProvider.tsx` → `new WsClient({ getToken: getAuthToken })` |
| **Supabase Storage uploads** | `Authorization: Bearer` header on PUT | `useDatasetUpload.ts` → direct fetch to pre-signed URL with token |

1. **Dev mode**: `VITE_AUTH_TOKEN` env var from `scripts/get-token.sh` output
2. **Prod**: Replace `getAuthToken()` body with Supabase Auth session token (deferred)

The existing `ThreadWsProvider` already takes a `getToken` callback — we pass `getAuthToken`. For Supabase Storage uploads, the backend's `GetUploadURL` returns a pre-signed URL that includes auth, so the frontend doesn't need to add auth headers for storage PUTs.

## Related Docs

- [Layout](layout.md) — workspace store drives panel switching
- [Dataset Upload](dataset-upload.md) — uses dataset store + TanStack Query hooks
- [3D Viewer](viewer-3d.md) — uses viewer store for mesh data
- [Activity Stream](activity-stream.md) — DISPLAY_RESULT triggers workspace store
