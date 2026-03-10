---
detail: standard
audience: developer, architect
---
# Recommended v2 Architecture Map

This maps the recommended transport redesign, not the current implementation.

## System Overview

```mermaid
flowchart LR
    subgraph Browser["Browser"]
        UI["Editor UI\nDocument tree\nProposal panels"]
        ProjCtx["ProjectCollabProvider"]
        ProjWS["ProjectCollabTransport\nOne project websocket"]
        SessMgr["DocumentSessionManager"]

        subgraph SessionA["DocumentSession A"]
            AState["Y.Doc\nProposal state\nIndexedDB persistence"]
            AWS["Document websocket"]
        end

        subgraph SessionB["DocumentSession B"]
            BState["Y.Doc\nProposal state\nIndexedDB persistence"]
            BWS["Document websocket"]
        end
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
    SessMgr --> SessionA
    SessMgr --> SessionB
    AState <--> AWS
    BState <--> BWS

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
    ProposalSvc --> ProjBroad
    ProposalSvc --> DocBroad
```

## Frontend Ownership

```mermaid
flowchart TD
    Open["User opens document"] --> Get["DocumentSessionManager.getOrCreate documentId"]
    Get --> Exists{"Session exists?"}
    Exists -->|No| Create["Create DocumentSession\nY.Doc\nSync runtime\nIndexedDB\nProposal manager\nDocument websocket"]
    Exists -->|Yes| Reuse["Reuse existing session"]
    Create --> Activate["Mark session active"]
    Reuse --> Activate
    Activate --> Bind["useDocumentCollab binds UI to session"]

    Bind --> Switch["User switches away"]
    Switch --> Warm["Session retained as warm\nSocket stays open\nY.Doc stays alive"]
    Warm --> Return["User returns within warm window"]
    Return --> Bind
    Warm --> Evict["Warm eviction or closeAll"]
    Evict --> Destroy["Destroy session exactly once"]
```

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
    PH-->>PWS: doc:edited
    DH-->>DWS: Yjs update
```

## Rules

| Area | Recommended rule |
|------|------------------|
| React ownership | Components bind to sessions. Components do not own `Y.Doc` lifetime. |
| Warm state | A warm session keeps websocket, `Y.Doc`, proposal state, and IndexedDB alive together. |
| Project WS | Project WS carries only JSON events and proposal commands. |
| Document WS | Document WS carries only document-scoped sync traffic. |
| Broadcasting | Project JSON fanout and document Yjs fanout use separate registries. |
| Migration | Cut over by client cohort or feature flag, not mixed payloads on one broadcaster. |
