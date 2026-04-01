# Biomedical Data Platform — MVP Spec

## Product Summary

Cloud-based agentic platform where biomedical researchers upload micro-CT data, run AI-assisted analysis (segmentation, measurement, statistics), visualize results in 2D/3D, and draft papers — all through conversational AI + interactive tools in one workspace.

**Target user**: Musculoskeletal researcher analyzing uCT scans of murine joints (grounding use case: OA severity assessment via geometric indices).

**Key insight**: Researchers currently bounce between Amira ($$$), GraphPad Prism, R, and Word. This platform unifies the workflow: data → analysis → visualization → paper.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser                                        │
│  Chat + Notebook + 3D Canvas (WebGPU) + Editor  │
│  Single WebSocket connection for everything     │
├────────────────────┬────────────────────────────┤
│  Go Backend        │  External Services         │
│  (Railway)         │                            │
│  Auth, LLM,        │  Daytona (CPU sandbox)     │
│  Projects,         │  ├── Python analysis       │
│  Threads,          │  ├── SimpleITK, scipy      │
│  Billing           │  └── Persistent state      │
│  WebSocket hub     │                            │
│                    │  HF Inference (optional)    │
│                    │  └── MedSAM3 "medical eyes" │
│                    │                            │
│                    │  Supabase (DB + Storage)    │
└────────────────────┴────────────────────────────┘
```

### WebSocket Protocol

Single connection per project session handles all communication:

```
WebSocket /ws/project/{id}
  ├── LLM streaming (assistant tokens)
  ├── User messages (turns, interjections, interrupts)
  ├── Code execution progress (stdout/stderr from Daytona)
  ├── Tool results (mesh binary frames, plot JSON, DataFrames)
  ├── Collaboration (Yjs sync)
  └── Presence (who's viewing what)
```

Binary WebSocket frames for mesh data (Float32Array vertices + Uint32Array faces) — no base64 encoding overhead. ~1MB for a full knee joint model.

## MVP Scope

### What's in MVP

1. **Chat with AI** — Ask questions, request analyses, get results inline
2. **Dataset upload** — Drag-and-drop DICOM/NIfTI/CSV, auto-metadata extraction
3. **Python notebook** — Code cells with output (Jupyter-like, built on CodeMirror)
4. **2D visualization** — Plotly charts inline (ROC curves, bar plots, Bland-Altman, scatter)
5. **3D viewer** — Interactive bone model viewer (rotate, zoom, slice planes)
6. **Measurement tools** — Click-to-measure distances on 3D models and 2D ortho slices
7. **Document editor** — Write papers with AI assistance (reuse existing Meridian editor)
8. **Citation search** — PubMed/CrossRef lookup and insertion

### What's NOT in MVP

- Marketplace (Phase 4)
- MedSAM3 integration (Phase 3 — validate classical methods first)
- Collaborative editing (already built in Meridian, but not priority for MVP launch)
- Batch processing (Phase 5)
- LaTeX export (Phase 4)
- nnU-Net training pipeline (future — needs accumulated labeled data)

## UI Design

### Workspace Layout

Reuse Meridian's existing two-panel layout with a mode switcher:

```
┌──────────────────────────────────────────────────────────┐
│  [Project Name]           [Dataset] [Notebook] [Paper]   │
├────────────────────┬─────────────────────────────────────┤
│                    │                                     │
│   CHAT PANEL       │   CONTENT PANEL                     │
│   (left, 40%)      │   (right, 60%)                      │
│                    │                                     │
│   AI conversation  │   Mode-dependent:                   │
│   with tool calls  │   • Dataset → table preview + stats │
│   and inline       │   • Notebook → code cells + output  │
│   results          │   • Paper → markdown editor         │
│                    │   • 3D View → interactive canvas    │
│                    │   • 2D Slice → ortho slice viewer   │
│                    │                                     │
│   [input box]      │                                     │
├────────────────────┴─────────────────────────────────────┤
│  Status bar: Python runtime status | Dataset loaded | ..  │
└──────────────────────────────────────────────────────────┘
```

### Content Panel Modes

#### 1. Dataset Mode
```
┌─────────────────────────────────────────┐
│ my-uct-scan.dcm          [Preview] [3D] │
├─────────────────────────────────────────┤
│ Type: DICOM stack (342 slices)          │
│ Resolution: 10.5 µm isotropic           │
│ Size: 847 MB                            │
│ Scanner: Scanco VivaCT 40               │
│ Voltage: 55 kVp | Current: 145 µA      │
├─────────────────────────────────────────┤
│ Slice 171/342          [◄] [slider] [►] │
│ ┌─────────────────────────────────────┐ │
│ │                                     │ │
│ │     [ortho slice image]             │ │
│ │     coronal / sagittal / axial tabs │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│ Threshold: [====|========] 2500 HU      │
│ Window/Level: [=====|=====]             │
└─────────────────────────────────────────┘
```

For CSV/tabular data:
```
┌─────────────────────────────────────────┐
│ supplemental-table-s3.csv    [Stats]    │
├─────────────────────────────────────────┤
│ Rows: 42 | Columns: 8                  │
│                                         │
│ │ Group   │ FemW │ FemL │ W/L  │ ...  ││
│ │─────────│──────│──────│──────│──────││
│ │ WT-NJ   │ 1.82 │ 1.54 │ 1.18 │      ││
│ │ WT-MMS4 │ 2.15 │ 1.57 │ 1.37 │      ││
│ │ WT-MMS8 │ 2.28 │ 1.56 │ 1.46 │      ││
│ │ ...     │      │      │      │      ││
├─────────────────────────────────────────┤
│ Column: W/L ratio                       │
│ Mean: 1.29 | SD: 0.12 | Range: 1.1-1.5│
│ [histogram visualization]               │
└─────────────────────────────────────────┘
```

#### 2. Notebook Mode
```
┌─────────────────────────────────────────┐
│ analysis.ipynb     [Run All] [Clear]    │
├─────────────────────────────────────────┤
│ [1] ▶ Python                            │
│ ┌───────────────────────────────────┐   │
│ │ import SimpleITK as sitk          │   │
│ │ img = sitk.ReadImage("scan.dcm")  │   │
│ │ arr = sitk.GetArrayFromImage(img) │   │
│ │ print(f"Shape: {arr.shape}")      │   │
│ └───────────────────────────────────┘   │
│ Out[1]: Shape: (342, 512, 512)          │
│                                         │
│ [2] ▶ Python                            │
│ ┌───────────────────────────────────┐   │
│ │ bone_mask = arr > 2500            │   │
│ │ # watershed segmentation...       │   │
│ └───────────────────────────────────┘   │
│ Out[2]: Segmented 3 regions             │
│         [inline 3D preview thumbnail]   │
│                                         │
│ [3] ▶ Python                            │
│ ┌───────────────────────────────────┐   │
│ │ fig = plot_roc(y_true, y_score)   │   │
│ └───────────────────────────────────┘   │
│ Out[3]: [interactive plotly ROC curve]   │
│                                         │
│ [+] Add cell                            │
└─────────────────────────────────────────┘
```

#### 3. 3D Viewer Mode
```
┌─────────────────────────────────────────┐
│ 3D View: knee_joint     [Ortho] [Full]  │
├─────────────────────────────────────────┤
│                                         │
│   ┌───────────────────────────────┐     │
│   │                               │     │
│   │    [Interactive 3D model]     │     │
│   │    femur (blue)               │     │
│   │    tibia (green)              │     │
│   │    patella (purple)           │     │
│   │    osteophyte (red)           │     │
│   │                               │     │
│   │    rotate / zoom / pan        │     │
│   │                               │     │
│   └───────────────────────────────┘     │
│                                         │
│ Tools: [Ruler] [Slice] [Hide/Show]      │
│                                         │
│ Structures:                             │
│   ☑ Femur          ☑ Tibia              │
│   ☑ Patella        ☑ Osteophytes        │
│   ☐ Sesamoids      ☑ Growth plate       │
│                                         │
│ Measurements:                           │
│   Femoral width:  2.28 mm               │
│   Femoral length: 1.56 mm               │
│   W/L ratio:      1.46                  │
│   [+ Add measurement]                   │
└─────────────────────────────────────────┘
```

#### 4. Paper Mode (existing Meridian editor)
```
┌─────────────────────────────────────────┐
│ manuscript.md    [Export DOCX] [Export PDF]│
├─────────────────────────────────────────┤
│                                         │
│ # μCT-derived geometric indices for     │
│   assessing OA severity                 │
│                                         │
│ ## Abstract                             │
│ Imaging is the gold standard for...     │
│                                         │
│ ## Results                              │
│                                         │
│ The distal femoral width-to-length      │
│ ratio was markedly elevated at 4 and    │
│ 8 weeks after MMS (1.33 ± 0.05 and     │
│ 1.47 ± 0.1) compared to contralateral  │
│ normal joints (1.19 ± 0.04) [1].       │
│                                         │
│ ![Figure 2](fig:roc-analysis)           │
│ [linked to notebook output]             │
│                                         │
│ ## References                           │
│ [1] Zhang Y. Clin Geriatr Med. 2010    │
│ [@search PubMed] [@insert citation]     │
│                                         │
└─────────────────────────────────────────┘
```

### Chat Panel — AI Interaction Patterns

The chat is the primary interface. Researchers talk naturally:

```
User: "I uploaded 20 DICOM scans from our MMS experiment. 
       Can you segment the bones and measure the geometric indices?"

AI: "I'll analyze all 20 scans. Starting with scan WT-001..."
    [executes python: loads DICOM, thresholds, watershed]
    [shows 3D preview in viewer]
    "Segmentation complete. I found femur, tibia, patella, and 
     2 suspected osteophytes on the medial condyle. 
     Does the segmentation look correct?"

User: "Region 5 is a sesamoid, not an osteophyte"

AI: "Got it — relabeling region 5 as sesamoid and excluding from 
     osteophyte measurements. Proceeding with geometric indices..."
    [measures femoral W/L, tibial IIOC H/W]
    [generates results table]
    "All 20 scans processed. Here are the results:
     [inline table + bar chart]
     Want me to run the statistical analysis?"

User: "Yes, ANOVA with Dunnett's post hoc, and generate ROC curves"

AI: [executes stats code]
    [shows ROC curves inline via Plotly]
    "AUC = 1.0 for both 4 and 8 week timepoints. 
     Cutoff value of >1.245 yields 100% sensitivity/specificity.
     Shall I draft the Results section for the paper?"
```

### How AI Uses Tools

The AI (Claude) has these tools available during chat:

| Tool | What it does | Where result appears |
|---|---|---|
| `execute_python` | Run Python code via Pyodide/Jupyter | Notebook cell + inline in chat |
| `render_3d` | Push mesh data to 3D viewer | 3D Viewer panel switches to show model |
| `render_plot` | Push Plotly JSON to chart renderer | Inline in chat + saveable to notebook |
| `search_pubmed` | Search PubMed API | Citation results in chat |
| `insert_citation` | Add reference to paper document | Paper editor updates |
| `edit_document` | Modify paper text | Paper editor updates (existing Meridian proposal system) |

The AI writes Python code for every analysis step. The code is visible in the notebook (researcher can inspect, modify, re-run). This is not a black box.

## Technical Implementation

### What exists (reuse from Meridian)

| Component | Status | Changes needed |
|---|---|---|
| Auth (Supabase JWT) | Done | None |
| Projects | Done | Rename conceptually (project = research study) |
| Documents + folders | Done | Add file types: .py, .ipynb, .dcm, .nii |
| Threads (AI chat) | Done | Add new tools (execute_python, render_3d, etc.) |
| LLM streaming + tool calling | Done | Register new tool executors |
| Document editor (CodeMirror) | Done | Add Python syntax mode for notebook cells |
| Collaboration (Yjs) | Done | Use for shared notebooks later |
| Billing (credits) | Done | None |
| Proposal accept/reject | Done | Reuse for AI-suggested paper edits |
| Two-panel layout | Done | Add mode switcher (Dataset/Notebook/3D/Paper) |

### What's new to build

#### Backend (Go)

1. **`execute_python` tool executor** — Creates/resumes Daytona sandbox, runs code, returns results
   - New file: `internal/service/llm/tools/execute_python.go`
   - Follows existing ToolExecutor interface exactly
   - Progress streamed via WebSocket, binary results (mesh) via binary frames

2. **`search_pubmed` tool executor** — HTTP call to NCBI E-utilities API
   - New file: `internal/service/llm/tools/search_pubmed.go`
   - Returns structured citation data (title, authors, journal, DOI, PMID)

3. **Dataset domain** — Upload, store, retrieve datasets
   - New domain: `internal/domain/dataset/`
   - Storage: Supabase Storage (S3-compatible)
   - Metadata extraction on upload (DICOM tags, CSV schema, etc.)
   - New migration: `datasets` table

4. **Biomedical personas** — Replace fiction personas
   - New files in `.agents/agents/`: data-analyst.md, stats-reviewer.md, methods-writer.md
   - System prompts with biomedical domain knowledge

5. **Biomedical skills** — Analysis workflows
   - New files in `.agents/skills/`: uct-segmentation, statistical-analysis, citation-search

#### Frontend (TypeScript/React)

1. **Daytona integration** — Sandbox management from frontend
   - New: `core/compute/daytona-client.ts` — Manages sandbox lifecycle (create/resume/stop)
   - New: `core/compute/execution-stream.ts` — Receives progress + results via WebSocket
   - Sandbox is persistent — packages installed once, DICOM data survives between sessions

2. **Notebook view** — Code cells + output
   - New feature: `features/notebook/`
   - CodeMirror with Python syntax highlighting (already supported)
   - Cell execution via Shift+Enter → sends to Pyodide worker
   - Output rendering: text, tables (DataFrame → HTML), Plotly charts, images (PNG base64)
   - Cell ordering, add/delete/move cells

3. **3D Viewer** — React Three Fiber canvas
   - New feature: `features/viewer3d/`
   - Accepts mesh data (vertices + faces + labels) from Python output
   - Structure toggle (show/hide femur, tibia, etc.)
   - Color-coded by label
   - Ruler tool: click two points → measure distance
   - Ortho slice overlay (coronal/sagittal/axial plane through volume)

4. **2D Slice Viewer** — Ortho slice viewer for DICOM stacks
   - New feature: `features/slice-viewer/`
   - Scroll through slices with slider
   - Window/level adjustment
   - Threshold overlay visualization
   - Measurement tool on slices

5. **Dataset browser** — Upload and preview
   - New feature: `features/datasets/`
   - Drag-and-drop upload with progress bar
   - DICOM: show metadata tags, slice preview, volume info
   - CSV: table preview, column stats, histograms
   - List view with search/filter

6. **Plot renderer** — Inline Plotly charts
   - New component: `shared/components/PlotlyChart.tsx`
   - Accepts Plotly JSON spec
   - Renders in chat (turn blocks) and in notebook (cell output)
   - Interactive (hover, zoom, pan)

7. **Mode switcher** — Content panel modes
   - Extend existing workspace layout
   - Tabs: Dataset | Notebook | 3D View | Slice | Paper
   - Each mode renders different content in the right panel
   - Chat panel stays constant on the left

8. **Citation UI** — Search and insert
   - New feature: `features/citations/`
   - Search modal: query PubMed, show results, one-click insert
   - Inline citation rendering in editor ([1], [2], etc.)
   - Auto-generated reference list at end of document

### Database (new migration)

```sql
-- Datasets
CREATE TABLE datasets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    file_type TEXT NOT NULL,        -- dicom, nifti, csv, parquet, etc.
    storage_path TEXT NOT NULL,      -- Supabase Storage path
    size_bytes BIGINT NOT NULL,
    num_slices INT,                  -- for volumetric data
    voxel_size_um FLOAT,            -- micrometers
    metadata JSONB DEFAULT '{}',    -- DICOM tags, CSV schema, etc.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_datasets_project ON datasets(project_id) WHERE deleted_at IS NULL;

-- Citations
CREATE TABLE citations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    doi TEXT,
    pmid TEXT,
    title TEXT NOT NULL,
    authors JSONB NOT NULL DEFAULT '[]',
    journal TEXT,
    year INT,
    abstract TEXT,
    bibtex TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, pmid),
    UNIQUE(project_id, doi)
);

-- Notebook cells (persistent execution state)
CREATE TABLE notebook_cells (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    position INT NOT NULL,
    cell_type TEXT NOT NULL DEFAULT 'code',  -- code, markdown, output
    source TEXT NOT NULL DEFAULT '',
    output JSONB,                             -- {type: "text"|"plot"|"table"|"image", data: ...}
    execution_count INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notebook_cells_doc ON notebook_cells(document_id);
```

## Python Packages (Daytona — full PyPI, no limitations)

| Package | Purpose |
|---|---|
| SimpleITK | DICOM/NIfTI loading, image processing, registration |
| numpy | Array operations |
| scipy | Statistics (ANOVA, t-test) |
| scikit-image | Watershed, morphology, marching cubes |
| scikit-learn | ROC, metrics |
| matplotlib | Static plots |
| plotly | Interactive plots |
| statsmodels | ICC, Bland-Altman |
| pandas | DataFrames |
| pydicom | DICOM metadata extraction |
| nibabel | NIfTI file reading |
| trimesh | 3D mesh operations, Draco export |

No package limitations — Daytona runs full Python with pip. SimpleITK, which doesn't work in Pyodide (C++ extensions), is available natively.

## Personas (AI Behavior Profiles)

### data-analyst (default)
```yaml
name: Data Analyst
description: Biomedical data analysis specialist
model: claude-sonnet-4-6
tools: [execute_python, render_3d, render_plot, search_pubmed, edit_document]
skills: [uct-segmentation, statistical-analysis]
```
System prompt: Expert in biomedical image analysis, micro-CT processing, bone morphometry, and statistical methods. Writes Python code for analysis. Shows work in notebook cells. Validates results visually before reporting.

### stats-reviewer
```yaml
name: Statistical Reviewer  
description: Checks statistical methodology and rigor
tools: [execute_python, render_plot]
skills: [statistical-analysis]
```
System prompt: Reviews statistical analyses for correctness. Checks: appropriate test selection, normality assumptions, multiple comparison corrections, effect sizes, power analysis. Suggests improvements.

### methods-writer
```yaml
name: Methods Writer
description: Drafts methods sections for papers
tools: [edit_document, search_pubmed, insert_citation]
skills: [citation-search]
```
System prompt: Writes clear, reproducible methods sections following journal conventions. Includes all relevant parameters (thresholds, voxel sizes, statistical tests, software versions). Cites appropriate references.

## Example End-to-End Workflow

```
1. Researcher creates project: "MMS OA Study 2026"

2. Uploads 20 DICOM stacks via drag-and-drop
   → Platform extracts metadata (scanner, resolution, kVp)
   → Shows slice preview for each

3. Chat: "Segment the bones in scan WT-001 and show me the 3D model"
   → AI writes Python: load DICOM, threshold, watershed
   → Code appears in notebook (inspectable)
   → 3D viewer shows colored model (femur=blue, tibia=green, patella=purple)
   → AI asks: "I found 5 regions. Does the segmentation look correct?"

4. Researcher rotates 3D model, notices a sesamoid labeled as osteophyte
   → Chat: "Region 5 is a sesamoid bone, not an osteophyte"
   → AI relabels, updates 3D view

5. Chat: "Measure the geometric indices"
   → AI writes code: PCA orientation correction, landmark detection,
     femoral W/L ratio, tibial IIOC H/W ratio
   → Results appear inline: "W/L = 1.47, IIOC H/W = 0.24"
   → Measurements shown on 3D model with ruler overlays

6. Chat: "Run this on all 20 scans"
   → AI iterates through all scans
   → Progress bar in chat
   → Results table appears when done

7. Chat: "Run ANOVA with Dunnett's post hoc comparing MMS groups to control"
   → AI writes scipy/statsmodels code
   → ROC curves, bar charts, Bland-Altman plots appear inline
   → All figures are interactive (Plotly)

8. Chat: "Draft the Results section"
   → AI writes text in Paper mode (right panel switches to editor)
   → Proposes text with inline figure references
   → Researcher accepts/rejects via existing proposal system

9. Chat: "Find citations for micro-CT bone morphometry guidelines"
   → AI searches PubMed, returns: Bouxsein et al. 2010 (JBMR)
   → One-click insert into paper

10. Export → DOCX for journal submission
```

## Implementation Priority

Build in this order (each step is independently demoable):

### Week 1-2: Python + Chat
- [ ] Pyodide Web Worker (load, execute, return results)
- [ ] `execute_python` tool executor (backend)
- [ ] Plotly output rendering in chat turn blocks
- [ ] Biomedical personas and skills (.agents/ files)
- [ ] Basic notebook view (code cells, text output)

### Week 3-4: Data + Visualization
- [ ] Dataset upload + storage (Supabase Storage)
- [ ] DICOM metadata extraction (pydicom in Pyodide)
- [ ] 2D slice viewer (scroll through DICOM stack)
- [ ] Plotly chart output in notebook cells
- [ ] DataFrame table rendering
- [ ] Mode switcher (Notebook / Dataset / Paper tabs)

### Week 5-6: 3D + Measurement
- [ ] React Three Fiber 3D canvas component
- [ ] Mesh rendering from marching cubes output
- [ ] Structure toggle (show/hide labeled regions)
- [ ] Ruler tool (click two points, show distance)
- [ ] Ortho slice plane overlay on 3D model
- [ ] `render_3d` tool (Python → 3D viewer)

### Week 7-8: Paper + Citations
- [ ] PubMed search tool (`search_pubmed`)
- [ ] Citation insertion into documents
- [ ] Reference list auto-generation
- [ ] Figure embedding (link notebook outputs to paper)
- [ ] DOCX export via Pandoc
- [ ] Stats reviewer persona validation

## Resolved Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Python runtime | Daytona CPU sandbox | Full PyPI (SimpleITK works), persistent state, $0.067/hr, $200 free credits |
| 3D rendering | Three.js / R3F with WebGPU | Falls back to WebGL2 automatically. Mesh rendering on any integrated GPU. |
| Streaming protocol | WebSocket (single connection) | Bidirectional, binary frames for mesh data, replaces SSE |
| MedSAM3 | HF Inference, optional "medical eyes" | Per-request, pennies, semantic check not critical path |
| GPU | Not needed for v1 | All uCT operations (threshold, watershed, marching cubes, stats) run fine on CPU in <45s per scan |
| Game streaming | Not needed | Mesh sent once (~1MB), all interaction local on user's GPU |

## Open Questions

1. **Notebook persistence?** — Notebook cells in DB (notebook_cells table) or as .ipynb documents? DB cells simpler for real-time sync. Could export as .ipynb for sharing.

2. **Daytona sandbox lifecycle** — One persistent sandbox per user (always available, auto-stops)? Or per-project? Or ephemeral per execution?

3. **Large DICOM storage** — Daytona persistent volume vs Supabase Storage? Volume is faster (no re-upload), but tied to Daytona. Supabase Storage is provider-agnostic.