# Biomedical MVP — Requirements

## Customer
Dad (Yao Lab, University of Rochester). Musculoskeletal researcher analyzing uCT scans of murine knee joints for OA severity assessment.

## Problem
"I've kinda given up on [CT image processing]." The image processing pipeline (DICOM → segmentation → 3D model → measurements) is manual, slow, and requires expensive software (Amira). Stats analysis requires bouncing between GraphPad Prism and R. Paper writing is disconnected from analysis.

## MVP Goal
An AI agent that autonomously processes uCT scans end-to-end: upload DICOMs → segment bones → validate with researcher at checkpoints → measure geometric indices → run statistics → generate figures → draft paper sections.

## Core Requirements

### 1. Daytona Sandbox with Bash Tool
- AI executes Python via bash in a persistent Daytona sandbox (not Pyodide — SimpleITK requires native C++)
- Persistent Jupyter kernel — variables and imports survive between executions
- AI writes reusable Python modules to the sandbox filesystem, then runs ephemeral scripts that import them
- Packages pre-installed: SimpleITK, scipy, numpy, pandas, scikit-image, plotly, matplotlib, pydicom, trimesh
- One persistent sandbox per project, auto-stops on idle
- Progress streamed via existing WebSocket

**Extensibility requirement**: Design the execution path so a streaming code fence interceptor (`python:run` blocks parsed from model output) can replace the bash tool as the trigger mechanism later. The downstream flow (execute → stream stdout → emit display results → render) must be identical regardless of trigger. See "Future: Code Fence Execution" below.

### 2. Display Results (generic concept)
- Any tool can emit "display results" — rich outputs shown prominently to the user
- Display results are NOT tool-specific. The concept is: a tool result that the user should see, vs internal results the model reasons about
- MVP display result types:
  - Plotly charts (JSON → interactive chart)
  - Matplotlib images (PNG base64 → image)
  - DataFrames (HTML table)
  - Mesh references (card with "View 3D" button)
- Text output (stdout/stderr) stays inside the collapsed activity block
- Mesh file download link (STL/OBJ export as byproduct)
- Python `show_*` helpers (`show_plotly()`, `show_matplotlib()`, `show_dataframe()`, `show_mesh()`) write display results to a result file; the backend reads and emits them as DisplayResult events

### 3. Frontend Activity Stream Model
- **ActivityBlock**: collapsible unit containing ALL "work" — thinking, tool calls, text between tool calls. User expands to see details.
- **Display results**: render OUTSIDE the collapsed ActivityBlock, always visible. These are the charts, images, tables, 3D model cards.
- **Final response text**: always visible after display results.
- One ActivityBlock per turn. All work collapses into it. Display results and final text punch out.
- This model is general — not Python-specific. Any tool that emits DisplayResults gets the same treatment.

### 4. Basic 3D viewer
- React Three Fiber canvas component
- Receives mesh data from Python (marching cubes → vertices + faces + labels)
- Color-coded by label (femur=blue, tibia=green, patella=purple, osteophyte=red)
- Rotate, zoom, pan
- Toggle structures on/off
- Purpose: researcher validates segmentation ("that's a sesamoid, not an osteophyte")

### 5. Dataset upload
- Drag-and-drop DICOM stacks into Supabase Storage
- Metadata extraction on upload (scanner info, resolution, slice count)
- Files accessible from Daytona sandbox
- datasets table in DB (project-scoped)

### 6. Biomedical agent profile
- Single .agents/agents/data-analyst.md
- Domain knowledge: uCT processing, bone morphometry, watershed segmentation, geometric indices (femoral W/L, tibial IIOC H/W), statistical methods
- Uses bash tool to write Python files and execute scripts in Daytona
- Shows work at each step, asks for validation at checkpoints

### 7. Frontend target: frontend-v2/
- Build on v2 (React 19, Tailwind v4, Storybook-first)
- v2 has UI atoms, editor, thread components, AG-UI activity stream, WebSocket client
- v2 does NOT have: layouts, routes, stores, API client — build these for biomedical from the start
- Desktop-only (researchers use large monitors)

## Future: Code Fence Execution (Option 2)
After MVP ships with bash tool (option 1), migrate to streaming code fence interceptor:
- Model writes `python:run` fenced blocks in its response (natural markdown, not JSON tool calls)
- Backend parses streaming response, intercepts on fence close
- Executes code in the same persistent kernel
- Injects stdout back into model context as if it were a tool result
- Display results (`show_*` calls) flow through the same DisplayResult pipeline
- Better for weaker/cheaper models that struggle with large code blocks in JSON
- The ONLY thing that changes is the trigger mechanism. Everything downstream is identical.

## NOT in MVP
- Code fence execution (option 2 — future, designed for extensibility)
- Notebook view (code visible in chat is enough)
- Measurement/ruler tools on 3D viewer
- Citation search / PubMed integration
- Marketplace
- MedSAM3 (cofounder validating separately)
- Paper editor mode (AI uses existing document editor)
- Pyodide (Daytona only)
- Collaborative editing for notebooks
- Batch processing UI

## Validation Criteria
Can reproduce the paper's full pipeline:
1. Load DICOM stacks from Scanco VivaCT 40
2. Segment femur, tibia, patella, osteophytes via threshold + watershed
3. Show 3D model for researcher validation
4. Correct orientation (PCA-based auto-alignment)
5. Detect anatomical landmarks
6. Extract geometric indices (femoral W/L ratio, tibial IIOC H/W ratio)
7. Run ANOVA with Dunnett's post hoc, ROC curves, Bland-Altman, ICC
8. Generate publication-quality figures
9. Draft results section text

## Key Decisions from Discussion
- Daytona over Pyodide: SimpleITK is non-negotiable, needs native C++
- Keep Supabase: upgrade to Pro ($25/mo), not worth switching infra now
- Keep "persona" terminology in code: PersonaCatalog already built, rename is churn
- One agent, not multiple: dad doesn't need to switch between AI personalities
- 3D viewer is MVP: can't validate segmentation from 2D slices alone
- Stats + paper writing ship with MVP but aren't the primary value — the CT processing is
- Mesh export (STL/OBJ) falls out naturally, validates second use case (Blender users)
- Ship on frontend-v2: build data layer fresh with biomedical in mind
- Desktop-only layout: zero value in mobile for researchers
- Bash tool for MVP (option 1), design for code fence migration (option 2)
- Persistent Jupyter kernel: variables survive between executions
- AI writes reusable modules to FS, runs ephemeral scripts via bash
- Display results are a generic concept: any tool can emit them, they render outside ActivityBlock
- ActivityBlock model: all work collapses, display results + final text are always visible

## Existing Infrastructure to Reuse
- Tool registry + ToolExecutor interface (backend)
- WebSocket protocol + binary frame support (backend)
- AG-UI event streaming (backend + frontend-v2)
- Activity stream reducer with tool call rendering (frontend-v2)
- Project/document tree (backend)
- PersonaCatalog + skill resolution (backend)
- UI atoms + design system (frontend-v2)
- Editor (CM6 + Yjs) (frontend-v2)
- Auth, billing, Supabase Storage integration
