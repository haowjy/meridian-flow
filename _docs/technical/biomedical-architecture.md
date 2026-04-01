---
detail: standard
audience: architect
---

# Biomedical Platform Architecture

Architecture diagrams for the Meridian biomedical data platform pivot. See `_docs/plans/biomedical-mvp-spec.md` for full spec and `_docs/plans/biomedical-platform-pivot.md` for design rationale.

## System Overview

```mermaid
flowchart TB
    subgraph Browser["Browser (WebGPU/WebGL2)"]
        Chat["Chat Panel<br/>40% left"]
        Content["Content Panel<br/>60% right"]
        WS["WebSocket Client"]

        Content --> DS["Dataset Mode"]
        Content --> NB["Notebook Mode"]
        Content --> V3["3D Viewer<br/>React Three Fiber"]
        Content --> SL["2D Slice Viewer"]
        Content --> PP["Paper Mode<br/>CodeMirror"]
    end

    subgraph GoBackend["Go Backend (Railway)"]
        API["HTTP API"]
        WSHub["WebSocket Hub"]
        LLM["LLM Service<br/>Tool Calling"]
        Tools["Tool Executors"]
        DatasetSvc["Dataset Service"]
        ComputeSvc["Compute Service"]

        LLM --> Tools
        Tools --> ExecPy["execute_python"]
        Tools --> Render3D["render_3d"]
        Tools --> SearchPM["search_pubmed"]
        Tools --> EditDoc["edit_document"]
    end

    subgraph External["External Services"]
        Daytona["Daytona CPU Sandbox<br/>Python + full PyPI"]
        HF["HF Inference<br/>MedSAM3 (optional)"]
        Supabase["Supabase<br/>PostgreSQL + Storage"]
    end

    WS <-->|"Single WebSocket"| WSHub
    Chat --> WS
    ExecPy -->|"REST API"| Daytona
    SearchPM -->|"E-utilities"| PubMed["PubMed API"]
    Render3D -->|"binary mesh"| WSHub
    ComputeSvc --> Daytona
    DatasetSvc --> Supabase
    API --> DatasetSvc
    LLM -->|"semantic check"| HF
    GoBackend --> Supabase
```

## Python Execution Flow

How `execute_python` tool calls flow from LLM through Daytona back to the browser.

```mermaid
sequenceDiagram
    participant U as Browser
    participant WS as WebSocket Hub
    participant LLM as LLM Service
    participant TE as ToolExecutor
    participant D as Daytona Sandbox

    U->>WS: User message
    WS->>LLM: Forward to Claude
    LLM->>TE: tool_use: execute_python
    TE->>D: POST /execute (Python code)
    D-->>TE: Stream stdout/stderr
    TE-->>WS: execution_progress frames
    WS-->>U: Real-time output
    D->>TE: Final result (text/JSON/binary)
    TE->>WS: execution_result
    WS->>U: Plotly JSON / DataFrame / mesh bytes
    TE->>LLM: Tool result for next turn
    LLM->>WS: Assistant response
    WS->>U: "Analysis complete..."
```

## 3D Mesh Data Pipeline

From DICOM in Daytona to interactive 3D model in the browser.

```mermaid
flowchart LR
    subgraph Daytona["Daytona Sandbox (Python)"]
        DICOM["DICOM Stack<br/>pydicom / SimpleITK"]
        Thresh["Threshold<br/>bone mask > 2500 HU"]
        WS2["Watershed<br/>scikit-image"]
        MC["Marching Cubes<br/>vertices + faces"]
        PCA["PCA Orientation<br/>numpy linalg"]
    end

    subgraph Wire["WebSocket Transport"]
        Bin["Binary Frame<br/>Float32 verts<br/>Uint32 faces<br/>Uint8 labels"]
    end

    subgraph BrowserR["Browser (WebGPU)"]
        BG["BufferGeometry"]
        R3F["React Three Fiber<br/>OrbitControls"]
        Ruler["Ruler Tool<br/>raycaster"]
    end

    DICOM --> Thresh --> WS2 --> MC
    MC --> PCA
    PCA --> Bin --> BG --> R3F
    R3F --> Ruler
```

## Two-Stage Segmentation

Threshold + watershed for WHERE boundaries are, optional MedSAM3 for WHAT each region is.

```mermaid
flowchart TB
    Input["uCT DICOM Stack"]

    subgraph Stage1["Stage 1: Watershed (Daytona CPU)"]
        T["Threshold > 2500 HU"]
        MF["3D Median Filter"]
        Seeds["Region-growing seeds<br/>3000-5000 HU range"]
        WSD["Marker-based Watershed"]
        Out1["N unlabeled 3D regions"]
    end

    subgraph Stage2["Stage 2: MedSAM3 (HF Inference, optional)"]
        Prompt["Text prompt per region<br/>femur / tibia / patella"]
        SAM["MedSAM3 2D check"]
        Labels["Semantic labels assigned"]
    end

    subgraph Downstream["Downstream Analysis"]
        Meas["Geometric Indices<br/>W/L ratio, IIOC H/W"]
        Stats["Statistics<br/>ANOVA, ROC, ICC"]
        Viz["3D Visualization<br/>color-coded structures"]
    end

    Input --> T --> MF --> Seeds --> WSD --> Out1
    Out1 -->|"always"| Downstream
    Out1 -->|"optional GPU check"| Stage2
    Stage2 --> Downstream
```

## WebSocket Protocol

Single connection per project session multiplexes all communication.

```mermaid
flowchart TB
    Conn["WebSocket /ws/project/id"]

    Conn --> LLMStream["LLM Streaming<br/>assistant tokens, tool_use"]
    Conn --> UserMsg["User Messages<br/>turns, interrupts"]
    Conn --> ExecProg["Execution Progress<br/>stdout, stderr from Daytona"]
    Conn --> ToolRes["Tool Results<br/>text frames: Plotly JSON, DataFrames<br/>binary frames: mesh vertices/faces"]
    Conn --> Collab["Collaboration<br/>Yjs sync, presence"]

    LLMStream -->|"text frame"| JSON1["JSON envelope"]
    ExecProg -->|"text frame"| JSON2["JSON envelope"]
    ToolRes -->|"binary frame"| BIN["Raw Float32/Uint32 arrays"]
    ToolRes -->|"text frame"| JSON3["Plotly spec / DataFrame"]
```

## Tool Registry Integration

How new biomedical tools plug into the existing Meridian tool system.

```mermaid
flowchart LR
    subgraph Existing["Existing Tools"]
        Edit["str_replace_based_edit_tool"]
        WebS["web_search"]
        Spawn["spawn_agent"]
    end

    subgraph New["New Biomedical Tools"]
        EP["execute_python"]
        R3["render_3d"]
        SP["search_pubmed"]
    end

    subgraph Registry["ToolRegistryBuilder"]
        B["NewToolRegistryBuilder()"]
        B --> W1[".WithEnabledDocumentTools()"]
        B --> W2[".WithWebSearch()"]
        B --> W3[".WithPythonExec()"]
        B --> W4[".WithRender3D()"]
        B --> W5[".WithPubMedSearch()"]
        B --> Build[".Build()"]
    end

    Build --> Factory["ToolRegistryFactory<br/>BuildProductionRegistry()"]
    Factory --> LLMSvc["LLM Service<br/>executes tool calls"]

    EP -.->|"implements ToolExecutor"| W3
    R3 -.->|"implements ToolExecutor"| W4
    SP -.->|"implements ToolExecutor"| W5
```

## Frontend Panel Architecture

How content panel modes integrate with the existing workspace layout.

```mermaid
flowchart TB
    WL["WorkspaceLayout.tsx"]
    WL --> LP["Left: Chat Panel<br/>ThreadView + ChatInput"]
    WL --> RP["Right: Content Panel<br/>DocumentPanel.tsx"]

    RP --> Store["useUIStore<br/>rightPanelState"]

    Store -->|"dataset"| DSM["DatasetBrowser<br/>features/datasets/"]
    Store -->|"notebook"| NBM["NotebookPanel<br/>features/notebook/"]
    Store -->|"viewer3d"| V3M["Viewer3D<br/>features/viewer3d/"]
    Store -->|"slice"| SLM["SliceViewer<br/>features/slice-viewer/"]
    Store -->|"paper"| PPM["DocumentEditor<br/>features/documents/"]
    Store -->|"skill-editor"| SKM["SkillEditorPanel<br/>existing"]

    subgraph ToolBlocks["Chat Tool Renderers (toolRegistry.ts)"]
        PEB["PythonExecutionBlock"]
        R3B["Render3DBlock"]
        PMB["PubMedResultBlock"]
    end

    LP --> ToolBlocks
```

## Persona and Skill System

Biomedical personas replace fiction personas using the same `.agents/` file system.

```mermaid
flowchart LR
    subgraph Personas[".agents/agents/"]
        DA["data-analyst.md<br/>default persona"]
        SR["stats-reviewer.md"]
        MW["methods-writer.md"]
    end

    subgraph Skills[".agents/skills/"]
        UCT["uct-segmentation/<br/>SKILL.md"]
        SA["statistical-analysis/<br/>SKILL.md"]
        CS["citation-search/<br/>SKILL.md"]
    end

    subgraph Backend["Backend Loading"]
        PC["PersonaCatalog"]
        SKR["SkillResolver"]
    end

    DA --> PC
    SR --> PC
    MW --> PC
    UCT --> SKR
    SA --> SKR
    CS --> SKR

    PC --> SysPrompt["System Prompt<br/>+ tool permissions"]
    SKR --> SysPrompt
    SysPrompt --> LLM2["LLM Service"]
```

## Implementation Phases

```mermaid
gantt
    title Biomedical MVP Build Plan
    dateFormat YYYY-MM-DD
    axisFormat %b %d

    section Phase 1
    Personas and Skills           :p1a, 2026-04-07, 5d
    execute_python + Daytona      :p1b, 2026-04-07, 10d
    WebSocket binary frames       :p1c, after p1b, 4d
    Plotly + DataFrame rendering  :p1d, after p1a, 7d

    section Phase 2
    Dataset backend domain        :p2a, after p1c, 7d
    Dataset frontend + upload     :p2b, after p2a, 5d
    Mode switcher                 :p2c, after p1d, 3d
    Notebook view                 :p2d, after p2c, 10d

    section Phase 3
    R3F 3D viewer                 :p3a, after p2d, 10d
    render_3d tool                :p3b, after p3a, 3d
    Ruler + measurement tools     :p3c, after p3b, 5d

    section Phase 4
    search_pubmed tool            :p4a, after p3c, 5d
    Citation UI                   :p4b, after p4a, 5d
    Paper enhancements            :p4c, after p4b, 5d
```
