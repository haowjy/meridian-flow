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
    Direct --> Router["navigate({ to, params })"]
    Router --> URLChange{"URL changed?"}

    URLChange -->|"Yes"| Effect["WorkspaceLayout effect\nsyncs UI to URL"]
    URLChange -->|"No\n(same doc)"| Skip["Effect skips\n(direct update already worked)"]

    Effect --> Done["UI shows editor"]
    Skip --> Done

    Back["Browser back"] --> Effect
    Refresh["Page refresh"] --> Effect

```

**Why two prongs:**
1. Direct updates -> instant UI feedback, handles same-URL clicks
2. URL effect -> syncs on back/forward/refresh

## Critical Pattern: getState()

**Bad** - Effect re-runs on state changes (race condition):
```typescript
const { activeDocumentId } = useUIStore(/* subscribes */)

useEffect(() => {
  if (activeDocumentId !== initialDocumentId) {
    setActiveDocument(initialDocumentId)  // Triggers re-render -> effect runs again!
  }
}, [initialDocumentId, activeDocumentId])  // State in deps
```

**Good** - Effect runs only on URL changes:
```typescript
useEffect(() => {
  const store = useUIStore.getState()  // Read without subscribing

  if (store.activeDocumentId !== initialDocumentId) {
    store.setActiveDocument(initialDocumentId)
  }
}, [initialDocumentId])  // Only URL param
```

See README.md for URL/state synchronization flow.

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Can't reopen current doc after toggle | `openDocument()` missing direct state update | Add state updates before `router.push()` |
| Browser back shows tree not editor | State in effect deps -> race condition | Use `getState()`, remove state from deps |
| Chat reloads on doc navigation | Chat effect depends on doc URL | Separate effects with own dependencies |

## Implementation

**Core files:**
- `frontend/src/core/lib/panelHelpers.ts:24-62` - Direct state updates
- `frontend/src/features/workspace/components/WorkspaceLayout.tsx` - URL sync effect
- `frontend/src/core/stores/useUIStore.ts` - State store
