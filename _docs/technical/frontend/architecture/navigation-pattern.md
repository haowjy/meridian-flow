---
detail: minimal
audience: developer
status: active
---

# Navigation Pattern

## Two-Pronged Approach

```mermaid
flowchart TD
    Click["User clicks document"] --> Direct["Direct state update\n(panelHelpers)"]
    Direct --> Router["router.push()"]
    Router --> URLChange{"URL changed?"}

    URLChange -->|"Yes"| Effect["WorkspaceLayout effect\nsyncs UI to URL"]
    URLChange -->|"No\n(same doc)"| Skip["Effect skips\n(direct update already worked)"]

    Effect --> Done["✓ UI shows editor"]
    Skip --> Done

    Back["Browser back"] --> Effect
    Refresh["Page refresh"] --> Effect

    style Direct fill:#2d7d2d,stroke:#1e4d1e,color:#fff
    style Effect fill:#2d5f8d,stroke:#1b3a56,color:#fff
    style Done fill:#2d8d2d,stroke:#1e5d1e,color:#fff
```

**Why two prongs:**
1. Direct updates → instant UI feedback, handles same-URL clicks
2. URL effect → syncs on back/forward/refresh

## Critical Pattern: getState()

**❌ Bad** - Effect re-runs on state changes (race condition):
```typescript
const { activeDocumentId } = useUIStore(/* subscribes */)

useEffect(() => {
  if (activeDocumentId !== initialDocumentId) {
    setActiveDocument(initialDocumentId)  // Triggers re-render → effect runs again!
  }
}, [initialDocumentId, activeDocumentId])  // State in deps
```

**✅ Good** - Effect runs only on URL changes:
```typescript
useEffect(() => {
  const store = useUIStore.getState()  // Read without subscribing

  if (store.activeDocumentId !== initialDocumentId) {
    store.setActiveDocument(initialDocumentId)
  }
}, [initialDocumentId])  // Only URL param
```

## State Management

```mermaid
flowchart LR
    subgraph "URL (source of truth)"
        URL["/projects/x/documents/A"]
    end

    subgraph "useUIStore"
        Active["activeDocumentId\n(persisted)"]
        Panel["rightPanelState\n(NOT persisted)"]
    end

    URL -->|"Effect syncs"| Active
    URL -->|"Effect syncs"| Panel

    Panel -.->|"Resets to 'documents'\non page load"| Default["'documents'"]

    style URL fill:#2d5f8d,stroke:#1b3a56,color:#fff
    style Panel fill:#8d5d2d,stroke:#5a3a1e,color:#fff
```

**Why rightPanelState isn't persisted:** URL is source of truth; effect syncs it on mount.

## Future: Chat Independence

```mermaid
flowchart LR
    URL["/projects/x/documents/A?chat=C"]

    subgraph "Independent Effects"
        DocEffect["Document effect\n[initialDocumentId]"]
        ChatEffect["Chat effect\n[chatId]"]
    end

    URL -->|"Doc param changes"| DocEffect
    URL -->|"Chat param changes"| ChatEffect

    DocEffect -.->|"Doesn't trigger"| ChatEffect
    ChatEffect -.->|"Doesn't trigger"| DocEffect

    style DocEffect fill:#2d7d2d,stroke:#1e4d1e,color:#fff
    style ChatEffect fill:#2d5f8d,stroke:#1b3a56,color:#fff
```

Navigating between documents won't reload chat data.

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Can't reopen current doc after toggle | `openDocument()` missing direct state update | Add state updates before `router.push()` |
| Browser back shows tree not editor | State in effect deps → race condition | Use `getState()`, remove state from deps |
| Chat reloads on doc navigation | Chat effect depends on doc URL | Separate effects with own dependencies |

## Implementation

**Core files:**
- `frontend/src/core/lib/panelHelpers.ts:24-62` - Direct state updates
- `frontend/src/app/projects/[id]/components/WorkspaceLayout.tsx:54-102` - URL sync effect
- `frontend/src/core/stores/useUIStore.ts` - State store
