---
detail: minimal
audience: developer
---

# Editor Caching and Document Loading

Two document modes based on `isCollabEnabled(extension)`:

| Mode | Extensions | Content owner | Hook |
|------|-----------|--------------|------|
| **Non-collab** | `.json`, `.yaml`, etc. | REST API + IndexedDB | `useDocumentContent` + `useDocumentSync` |
| **Collab** | `.md`, `.markdown`, `.txt` | Yjs Y.Doc | `useDocumentCollab` |

See `features/documents/lib/collabFeatureFlag.ts` for the gate function.

## Architecture

```mermaid
flowchart TB
    EP[EditorPanel] --> UDC[useDocumentContent]
    EP --> UDS[useDocumentSync]
    EP --> UDCol[useDocumentCollab]
    EP --> CM[CodeMirrorEditor]

    UDC --> ES[useEditorStore]
    UDS --> DSS[DocumentSyncService]
    DSS --> IDB[IndexedDB]
    DSS --> API[Backend API]

    UDCol --> YJS[Y.Doc]
    YJS --> YIDB[y-indexeddb]
    YJS --> WS[WebSocket]
```

### Hook Responsibilities

- **`useDocumentContent`** -- Loads document (reconcile-newest), hydrates editor, tracks local state and edit versions. See `features/documents/hooks/useDocumentContent.ts`.
- **`useDocumentSync`** -- Debounced save (1s), fire-and-forget async flush on unmount, corruption repair. Pure effect, no return value. Non-collab only. See `features/documents/hooks/useDocumentSync.ts`.
- **`useDocumentCollab`** -- Yjs sync runtime, y-indexeddb, WebSocket transport, proposal management. See `features/documents/hooks/useDocumentCollab.ts`.

## Non-Collab: Open Document (reconcile-newest)

```mermaid
sequenceDiagram
    autonumber
    participant EP as EditorPanel
    participant UDC as useDocumentContent
    participant Store as useEditorStore
    participant Cache as IndexedDB
    participant API as Backend API

    EP->>UDC: mount
    UDC->>Store: loadDocument

    rect rgba(128, 128, 128, 0.08)
        Note over Store,API: Parallel fetch
        Store->>Cache: get cached doc
        Store->>API: GET /api/documents/D
    end

    alt Cache hit
        Cache-->>Store: show immediately
    end

    alt API 200
        API-->>Store: pick newer by updatedAt
    else API error + cache hit
        Note over Store: keep cached doc
    else API error + no cache
        Store-->>UDC: error
    end
```

## Non-Collab: Typing to Autosave

```mermaid
sequenceDiagram
    autonumber
    participant CM as CodeMirror
    participant UDS as useDocumentSync
    participant DSS as DocumentSyncService
    participant IDB as IndexedDB
    participant API as Backend API

    CM->>UDS: content change
    Note over UDS: debounce 1s
    UDS->>DSS: save
    DSS->>IDB: optimistic update
    DSS->>API: PATCH /api/documents/D

    alt Success
        API-->>DSS: serverDoc
    else Network error
        DSS->>IDB: persist to pendingDocumentSaves
        Note over DSS: Retry on next startup/online
    end
```

**Flush on unmount**: Cleanup reads latest content from editor ref and calls `documentSyncService.save()` as fire-and-forget async (not synchronous). Ensures last-second edits are not lost.

## Collab Path (Yjs)

When collab is enabled, `useDocumentContent` loads metadata but skips REST hydration. `useDocumentSync` is disabled. `useDocumentCollab` takes over:

```mermaid
sequenceDiagram
    autonumber
    participant UDCol as useDocumentCollab
    participant YDoc as Y.Doc
    participant IDB as y-indexeddb
    participant WS as WebSocket

    UDCol->>YDoc: create Y.Doc + ytext
    UDCol->>IDB: IndexeddbPersistence
    UDCol->>WS: subscribeDocument

    rect rgba(128, 128, 128, 0.08)
        Note over IDB,WS: Race -- first to complete unblocks editor
        IDB-->>YDoc: cached state
        WS-->>UDCol: doc:subscribed
    end

    UDCol-->>UDCol: provide collab extensions to CodeMirror
```

**Key behaviors**: IDB timeout at 3s. IDB destroyed after initial sync, then recreated for ongoing offline caching. AI edits arrive as proposals via WebSocket (see `ProposalManager`).

## Race Condition Guards

1. **Intent flag** (`_activeDocumentId`): Every await checks this before applying state
2. **AbortSignal**: Per-load controller; cleanup aborts in-flight requests
3. **editVersion tracking**: Functional setState avoids reverting edits during save round-trip
4. **pendingServerSnapshot**: Server updates stashed (not applied) while user has unsaved edits

## Key Files

- `features/documents/components/EditorPanel.tsx` -- Orchestrates all hooks
- `features/documents/hooks/useDocumentContent.ts` -- Loading, hydration, local state
- `features/documents/hooks/useDocumentSync.ts` -- Debounced save, flush on unmount
- `features/documents/hooks/useDocumentCollab.ts` -- Yjs sync, proposals, connection state
- `core/stores/useEditorStore.ts` -- Document loading (reconcile-newest)
- `core/services/documentSyncService.ts` -- Optimistic save + persistent retry
- `core/lib/cache.ts` -- Cache policy framework
