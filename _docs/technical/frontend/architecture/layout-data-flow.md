---
detail: standard
audience: developer
---

# Layout Data Flow

How URL state, Zustand stores, and ready flags coordinate to render the workspace.

## URL -> State Flow

```mermaid
flowchart TB
    URL["URL<br/>/projects/{slug}/documents/{path}<br/>or /skills/{name}"]

    subgraph WL["WorkspaceLayout (Orchestrator)"]
        Parse["Parse URL segments<br/>(slug, path, skillName)"]
        Resolve["Resolve identifiers<br/>(path -> documentId, name -> skillId)"]
        Sync["Sync to store<br/>(via getState())"]
    end

    subgraph Stores["Zustand Stores"]
        UI["useUIStore<br/>• activeDocumentId<br/>• activeSkillId<br/>• leftPanelReady<br/>• rightPanelReady"]
        Project["useProjectStore<br/>• currentProject<br/>• projects[]"]
        Tree["useTreeStore<br/>• documents[]<br/>• folders[]"]
        Thread["useThreadStore<br/>• threads[]<br/>• activeTurnId"]
    end

    subgraph Components["Rendering"]
        Panel["DocumentPanel"]
        Editor["EditorPanel / SkillEditorPanel"]
        Chat["ActiveThreadView"]
    end

    URL --> WL
    WL --> Stores
    Stores --> Components

    style URL fill:#2d5a4a,color:#fff
    style WL fill:#5a4a3a,color:#fff
    style Stores fill:#6a5a2a,color:#fff
    style Components fill:#4a5a3a,color:#fff
```

## Store Interaction Patterns

### Subscribe for Display, Read for Action

```typescript
// ✅ Subscribe: Component re-renders when value changes
const { activeDocumentId } = useUIStore()

// ✅ Read: Get current value without subscribing (in effects/handlers)
useEffect(() => {
  const store = useUIStore.getState()
  if (effectiveDocumentId) {
    store.setActiveDocument(effectiveDocumentId)
  }
}, [effectiveDocumentId])
```

**Why?** Prevents subscription loops where a component subscribes to state it also updates.

### Key Stores

| Store | Purpose | Key State |
|-------|---------|-----------|
| `useUIStore` | UI state, panel collapse, active selections | `activeDocumentId`, `activeSkillId`, `*PanelReady`, `*PanelUserOverride` |
| `useProjectStore` | Project data, current selection | `currentProject`, `projects` |
| `useTreeStore` | Document tree data | `documents`, `folders` |
| `useThreadStore` | Thread/turn data | `threads`, `activeTurnId` |

## Ready Flag Flow

Ready flags control panel auto-collapse behavior during data loading.

```mermaid
flowchart LR
    subgraph Hooks["Data Loading Hooks"]
        TH["useThreadsForProject<br/>(status: 'success'/'error')"]
        DT["DocumentTreeContainer<br/>(tree load status)"]
    end

    subgraph Store["useUIStore"]
        LR["leftPanelReady"]
        RR["rightPanelReady"]
    end

    subgraph Layout["TwoPanelLayout"]
        LC["Left panel collapse<br/>(if !ready && !userOverride)"]
        RC["Right panel collapse<br/>(if !ready && !userOverride)"]
    end

    TH -->|"success/error"| LR
    DT -->|"success/error"| RR
    LR --> LC
    RR --> RC

    style Hooks fill:#2d5a4a,color:#fff
    style Store fill:#5a4a3a,color:#fff
    style Layout fill:#6a5a2a,color:#fff
```

**Who Sets Ready Flags:**

| Flag | Set By | Condition |
|------|--------|-----------|
| `leftPanelReady` | `useThreadsForProject` | `status === 'success' \|\| status === 'error'` |
| `rightPanelReady` | `DocumentTreeContainer` | Tree data loaded or errored |

## Panel Collapse State Machine

```mermaid
stateDiagram-v2
    [*] --> AutoMode: userOverride = null

    state AutoMode {
        [*] --> Collapsed: ready = false
        Collapsed --> Expanded: ready = true
        Expanded --> Collapsed: ready = false
    }

    AutoMode --> Manual: User clicks toggle

    state Manual {
        ManualCollapsed: override = 'collapsed'
        ManualExpanded: override = 'expanded'
        ManualCollapsed --> ManualExpanded: User expands
        ManualExpanded --> ManualCollapsed: User collapses
    }

    note right of Manual: Persisted to localStorage
```

**State Priority:**
1. `userOverride !== null` -> Use override value (persisted)
2. `userOverride === null` -> Follow `ready` flag (session-scoped)

## URL Resolution

### Document Path Resolution

```typescript
// URL: /projects/my-novel/documents/characters/heroes/aria
// effectiveDocumentPath = "characters/heroes/aria"

const effectiveDocumentId = useMemo(() => {
  if (!effectiveDocumentPath) return undefined
  const doc = documents.find(d => d.path === effectiveDocumentPath)
  return doc?.id
}, [effectiveDocumentPath, documents])
```

### Skill Name Resolution

```typescript
// URL: /projects/my-novel/skills/writing-coach
// effectiveSkillName = "writing-coach"

const effectiveSkillId = useMemo(() => {
  if (!effectiveSkillName) return undefined
  const skill = skills.find(s => s.name === effectiveSkillName)
  return skill?.id
}, [effectiveSkillName, skills])
```

## Navigation Helpers

`frontend/src/core/lib/panelHelpers.ts` provides navigation functions that update both state and URL:

```typescript
// Opens a document: updates state immediately, then URL
openDocument(documentId, projectSlug, documentPath)

// Opens a skill: updates state immediately, then URL
openSkill(skillId, projectSlug, skillName)

// Navigates to tree view (no document selected)
openTree(projectSlug)
```

**Pattern**: State-first navigation for instant feedback, URL update for browser history.

## Project Switching

When switching projects, state must reset to prevent context leakage:

```mermaid
sequenceDiagram
    participant URL
    participant WL as WorkspaceLayout
    participant Store as useUIStore

    URL->>WL: /projects/new-project/...
    WL->>WL: Detect project change
    WL->>Store: setActiveDocument(null)
    WL->>Store: setActiveSkill(null)
    WL->>Store: setRightPanelState('documents')
    WL->>Store: setLeftPanelReady(false)
    WL->>Store: setRightPanelReady(false)
    Note over Store: userOverride NOT reset<br/>(user preference persists)
```

**First Load Exception**: When `previousProjectId === null`, skip reset to preserve deep-link state.

## Related Documentation

- **Layout Architecture**: `layout-system.md` - Component structure, panel sizing
- **Navigation Pattern**: `navigation-pattern.md` - URL patterns, routing
- **State Management**: `frontend/CLAUDE.md` - Store conventions
