# Biomedical MVP — Requirements

## Customer
Dad (Yao Lab, University of Rochester). Musculoskeletal researcher analyzing uCT scans of murine knee joints for OA severity assessment.

## Problem
"I've kinda given up on [CT image processing]." The image processing pipeline (DICOM → segmentation → 3D model → measurements) is manual, slow, and requires expensive software (Amira). Stats analysis requires bouncing between GraphPad Prism and R. Paper writing is disconnected from analysis.

## MVP Goal
An AI agent that autonomously processes uCT scans end-to-end: upload DICOMs → segment bones → validate with researcher at checkpoints → measure geometric indices → run statistics → generate figures → draft paper sections.

## Core Requirements

### 1. Two Tools: `python` + `bash`
- **`python` tool**: Input is raw Python code. Always executes in persistent Jupyter kernel. Always wrapped with result_helper (captures images, charts, tables, meshes via `show_*` helpers). This is the primary tool for analysis.
- **`bash` tool**: Input is a shell command. For file operations, pip install, non-Python tasks. No result capture, no kernel.
- Both run in a persistent Daytona sandbox (not Pyodide — SimpleITK requires native C++)
- Persistent Jupyter kernel — variables and imports survive between `python` executions
- AI writes reusable Python modules to the sandbox filesystem via `bash`, then runs analysis code via `python` that imports them
- Packages pre-installed: SimpleITK, scipy, numpy, pandas, scikit-image, plotly, matplotlib, pydicom, trimesh
- One persistent sandbox per project, auto-stops on idle

**Extensibility requirement**: The `python` tool is designed to be replaceable by a streaming code fence interceptor (```python:run` blocks parsed from model output). The downstream flow (ExecInKernel → stream stdout → read result.json → emit results → render) must be identical regardless of trigger mechanism. Nothing downstream should know or care whether code came from a tool call or a code fence. See "Future: Code Fence Execution" below.

### 2. Result Capture Protocol
- Python `show_*` helpers in `result_helper.py` (pre-installed in sandbox):
  - `show_plotly(fig)` — capture Plotly chart
  - `show_matplotlib(fig)` — capture matplotlib image as PNG
  - `show_dataframe(df, title)` — capture DataFrame as HTML table
  - `show_mesh(verts, faces, mesh_id, label, color)` — send mesh to 3D viewer
- Results written to `/workspace/.meridian/result.json` + binary mesh files
- Backend reads result file after execution, emits as events
- Results render **inline with text** in the visible output area — they are content, not a separate category

### 3. Frontend Activity Stream Model
**ActivityBlock** = one per turn. Contains all items. Each item has a per-item collapse default based on its kind and tool category:

- **Thinking** → collapsed by default
- **Tool input/args** → collapsed by default
- **Tool stdout** → depends on tool category (python: uncollapsed, bash: collapsed)
- **Tool stderr** → hidden by default (click for popup)
- **Text content** → never collapsed
- **Display results** (charts, images, tables, mesh cards) → never collapsed, inline with text

User can toggle any item.

**Per-tool-category display config** (extensible):

| Tool | Input (code/command) | stdout | stderr | Results |
|------|---------------------|--------|--------|---------|
| python | collapsed | uncollapsed | hidden (click for popup) | inline with text |
| bash | collapsed | collapsed | collapsed | n/a |
| read | collapsed | collapsed | collapsed | n/a |
| edit | collapsed | collapsed | collapsed | n/a |

Each tool category defines default collapse state for input, stdout, stderr. New tool categories register their own defaults. User can always toggle.

**stderr handling**: Hidden by default. Click to see in a popup/modal. Stderr is usually noise (warnings, deprecation) unless there's an error. Available for debugging but doesn't clutter the output.

### 4. 3D Viewer — Multi-Mesh Scene
- React Three Fiber canvas, lives in right panel
- **Multiple named meshes** managed by ID:
  - `show_mesh(verts, faces, mesh_id="femur", label="Femur", color="blue")` — add mesh
  - Same `mesh_id` = replace existing mesh
  - New `mesh_id` = add to scene
  - AI controls what's in the scene through IDs it chooses
- User controls:
  - Toggle visibility per mesh (checkboxes)
  - All meshes loaded simultaneously in scene
  - Rotate, zoom, pan (OrbitControls)
- No per-vertex label splitting on frontend — each `show_mesh()` call is one complete mesh
- Purpose: researcher validates segmentation ("that's a sesamoid, not an osteophyte")

### 5. Dataset Upload
- Drag-and-drop DICOM stacks into Supabase Storage
- Metadata extraction on upload (scanner info, resolution, slice count)
- Files accessible from Daytona sandbox
- datasets table in DB (project-scoped)

### 6. Biomedical Agent Profile
- Single `.agents/agents/data-analyst.md`
- Domain knowledge: uCT processing, bone morphometry, watershed segmentation, geometric indices (femoral W/L, tibial IIOC H/W), statistical methods
- Uses `python` tool for analysis, `bash` tool for file operations
- Shows work at each step, asks for validation at checkpoints

### 7. Frontend Target: frontend-v2/
- Build on v2 (React 19, Tailwind v4, Storybook-first)
- v2 has UI atoms, editor, thread components, AG-UI activity stream, WebSocket client
- v2 does NOT have: layouts, routes, stores, API client — build these for biomedical from the start
- Desktop-only (researchers use large monitors)

## Future: Code Fence Execution (Option 2)
After MVP ships with `python` tool (option 1), migrate to streaming code fence interceptor:
- Model writes `python:run` fenced blocks in its response (natural markdown, not JSON tool calls)
- Backend parses streaming response, intercepts on fence close
- Executes code in the same persistent kernel via same `ExecInKernel` interface
- Injects stdout back into model context as if it were a tool result
- Results (`show_*` calls) flow through the same result capture pipeline
- Frontend renders identically — code block with collapsible input, visible output, inline results
- Better for weaker/cheaper models that struggle with large code blocks in JSON
- The `python` tool goes away. The `bash` tool stays. Everything downstream is unchanged.

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
- Two tools: `python` (raw code, kernel, result capture) + `bash` (shell commands, file ops)
- `python` tool designed to be replaceable by code fence syntax — downstream is trigger-agnostic
- Persistent Jupyter kernel: variables survive between `python` executions
- AI writes reusable modules to FS via `bash`, runs analysis via `python`
- Images/charts/tables are inline content (like text), not a separate display result category
- 3D viewer: multi-mesh scene managed by mesh ID (same ID = replace, new ID = add)
- Per-tool-category display config: extensible collapse defaults for input/stdout/stderr
- stderr hidden by default, click-to-view popup
- ActivityBlock: per-item collapse defaults based on item kind and tool category

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
