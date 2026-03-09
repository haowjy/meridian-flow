---
detail: minimal
audience: developer
---

# Layout Data Flow

How URL state, Zustand stores, and ready flags coordinate to render the workspace.

## URL to Rendering Pipeline

```mermaid
flowchart TB
    URL["URL\n/projects/slug/documents/path\nor /skills/name"]

    subgraph WL["WorkspaceLayout"]
        Parse["Parse URL segments"]
        Resolve["Resolve path to ID"]
        Sync["Sync to stores via getState"]
    end

    subgraph Stores["Zustand Stores"]
        UI["useUIStore"]
        Project["useProjectStore"]
        Tree["useTreeStore"]
        Thread["useThreadStore"]
        Skill["useSkillStore"]
    end

    subgraph Components["Rendering"]
        Panel["DocumentPanel"]
        Editor["EditorPanel / SkillEditorPanel"]
        Chat["ActiveThreadView"]
    end

    URL --> WL
    WL --> Stores
    Stores --> Components
```

Stores are in `frontend/src/core/stores/`. See `frontend/CLAUDE.md` for store conventions and the "Subscribe for Display, Read for Action" pattern.

## Ready Flag Flow

Ready flags control right panel auto-collapse during data loading.

```mermaid
flowchart LR
    subgraph Hooks["Data Loading"]
        TH["useThreadsForProject"]
        DT["DocumentTreeContainer"]
    end

    subgraph Store["useUIStore"]
        LR["leftPanelReady"]
        RR["rightPanelReady"]
    end

    subgraph Layout["TwoPanelLayout"]
        RC["Right panel collapse\nif !ready and !userOverride"]
    end

    TH -->|"success/error"| LR
    DT -->|"success/error"| RR
    RR --> RC
```

`leftPanelReady` is only used by `WorkspaceRail` for icon highlighting -- it does not collapse the left panel.

## Right Panel Collapse Logic

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
        ManualCollapsed: override = collapsed
        ManualExpanded: override = expanded
        ManualCollapsed --> ManualExpanded: User expands
        ManualExpanded --> ManualCollapsed: User collapses
    }
```

Priority: `userOverride !== null` wins over `ready` flag. Override is persisted to localStorage; ready flags are session-scoped.

## Navigation Helpers

`frontend/src/core/lib/panelHelpers.ts` provides state-first navigation (instant feedback, then URL update for browser history):

| Function | Purpose |
|----------|---------|
| `openDocument(documentId, documentPath, projectSlug, navigate)` | Opens doc in editor, expands right panel |
| `openSkill(skillId, skillName, projectSlug, navigate)` | Opens skill in editor, expands right panel |
| `closeEditor(projectSlug, navigate)` | Clears active doc, returns to tree view |
| `decodeDocumentPath(urlPath)` | Decodes URL path back to document path (handles double-encoding) |

## Project Switching

When switching projects, `WorkspaceLayout` resets all document/skill/thread state to prevent context leakage. User panel override is preserved (it's a preference, not project-specific). First load skips reset to preserve deep-link state.

See `WorkspaceLayout.tsx` project change effect.
