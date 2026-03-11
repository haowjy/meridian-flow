---
detail: standard
audience: developer, architect
---
# v2 Architecture Map

Maps the implemented transport redesign. Warm pool and `doc:edited` are deferred (see `ws-patterns.md`).

## System Overview

```mermaid
flowchart LR
    subgraph Browser["Browser"]
        UI["Editor UI\nDocument tree\nProposal panels"]
        ProjCtx["ProjectCollabProvider"]
        ProjWS["ProjectCollabTransport\nOne project websocket"]
        SessMgr["DocumentSessionManager\nWS + CollabSyncRuntime"]

        subgraph HookA["useDocumentCollab (doc A)"]
            AState["Y.Doc + IndexedDB\nProposal state"]
        end

        subgraph HookB["useDocumentCollab (doc B)"]
            BState["Y.Doc + IndexedDB\nProposal state"]
        end

        AWS["Document WS A"]
        BWS["Document WS B"]
    end

    subgraph Backend["Go backend"]
        ProjHandler["Project WS handler\nJSON only"]
        ProjRegistry["ProjectConnectionRegistry"]
        ProjBroad["ProjectProposalBroadcaster"]

        DocHandler["Document WS handler\nYjs sync transport"]
        SessRuntime["DocumentSessionManager\nIn-memory Yjs sessions"]
        DocBroad["Document broadcaster\nPer-document fanout"]

        ProposalSvc["Proposal service"]
        ProposalStore["Proposal store"]
        StateStore["Yjs state store"]
        SnapshotStore["Snapshot store"]
        DocResolver["Document resolver\nAuth checks"]
    end

    UI --> ProjCtx
    UI --> SessMgr
    ProjCtx --> ProjWS
    SessMgr --> AWS
    SessMgr --> BWS
    AState <--> SessMgr
    BState <--> SessMgr

    ProjWS -->|"JSON events and commands"| ProjHandler
    AWS -->|"Raw Yjs frames"| DocHandler
    BWS -->|"Raw Yjs frames"| DocHandler

    ProjHandler --> ProjRegistry
    ProjHandler --> DocResolver
    ProjBroad --> ProjRegistry

    DocHandler --> DocResolver
    DocHandler --> SessRuntime
    DocHandler --> DocBroad

    SessRuntime --> StateStore
    SessRuntime --> SnapshotStore

    ProposalSvc --> ProposalStore
    ProposalSvc --> SessRuntime
    ProposalSvc -->|"proposal JSON events"| ProjBroad
    ProposalSvc -->|"Yjs update fanout (binary)"| DocBroad
```

## Frontend Ownership

```mermaid
flowchart TD
    Open["User opens document"] --> Get["DocumentSessionManager.acquire(documentId)"]
    Get --> Exists{"Session exists\nin map?"}
    Exists -->|No| Create["Create ManagedDocumentSession\nWS + CollabSyncRuntime\nrefCount = 1"]
    Exists -->|Yes| Reuse["refCount++"]
    Create --> Bind["useDocumentCollab binds\nY.Doc + IndexedDB + proposals\nto session runtime"]
    Reuse --> Bind

    Bind --> Switch["User switches away\nsessionManager.release()"]
    Switch --> Dec["refCount--"]
    Dec --> Zero{"refCount == 0?"}
    Zero -->|Yes| Destroy["Close WS\nDestroy runtime\nRemove from map"]
    Zero -->|No| Keep["Session stays alive\nfor other consumers"]
```

Note: Y.Doc, IndexedDB, and proposal state live in `useDocumentCollab` hook, NOT in the session manager. The session manager owns only WS + runtime. Warm pool (deferred) would change the refCount=0 path to retain sessions temporarily.

## Backend Event Split

```mermaid
sequenceDiagram
    participant UI as "Editor UI"
    participant PWS as "Project WS"
    participant DSM as "DocumentSessionManager"
    participant DWS as "Document WS"
    participant PH as "Project WS handler"
    participant DH as "Document WS handler"
    participant PS as "Proposal service"

    UI->>DSM: activate document
    DSM->>DWS: connect
    DWS->>DH: auth and sync
    DH-->>DWS: connected and Yjs frames

    UI->>PWS: proposal:accept
    PWS->>PH: JSON command
    PH->>PS: accept proposal
    PS-->>PH: proposal status mutation
    PS-->>DH: accepted Yjs update fanout
    PH-->>PWS: proposal:statusChanged
    Note over PH,PWS: doc:edited deferred (IL-16)
    DH-->>DWS: Yjs update
```

## Rules

| Area | Rule | Status |
|------|------|--------|
| React ownership | `useDocumentCollab` owns Y.Doc, IndexedDB, proposal state. Session manager owns WS + runtime only. | Implemented |
| Project WS | JSON events and proposal commands only. No binary frames. | Implemented |
| Document WS | Document-scoped Yjs sync traffic only. `coder/websocket` library. | Implemented |
| Broadcasting | `ProjectBroadcaster` (JSON to project WS) and `DocumentBroadcaster` (binary to document WS) are separate interfaces. | Implemented |
| Warm pool | Release retains session with open WS for instant re-acquire. | Deferred (IL-15) |
| `doc:edited` | Project WS notification when server-side edits occur. | Deferred (IL-16) |
| `proposal:snapshot` | Sent on project WS connect for documents with pending proposals. | Broken (IL-13) |
