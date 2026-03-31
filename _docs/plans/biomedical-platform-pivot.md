# Biomedical Data Platform — Design & Implementation Plan

## Vision

Transform Meridian from a fiction writing platform into an **agentic biomedical data platform** — a cloud-based environment where researchers can analyze biomedical data through AI-assisted Python execution, interactive N-D visualization, and collaborative paper writing, with a marketplace for sharing workflows and tools.

## Grounding Use Case: uCT-based OA Assessment

Reference: Yao et al., "uCT-derived geometric indices for assessing OA severity in murine knee joints" (Biology, 2025, PMC12896453)

### Current Pain Points (from the paper)

| Pain Point | Current Approach | Platform Solution |
|---|---|---|
| 3D segmentation is manual and slow | Amira software (expensive, semi-manual watershed) | AI-assisted segmentation via Python (SimpleITK/scikit-image) |
| Image orientation correction is "time-consuming and unfeasible" | Manual 3-axis rotation in Amira | **AI-powered auto-alignment** (the paper explicitly calls for this) |
| Geometric measurements require trained operators | Amira ruler tool on 3D models | Interactive 3D measurement tools + automated extraction |
| Statistical analysis in separate tools | GraphPad Prism + R (copy-paste between tools) | Integrated Python (scipy, statsmodels) with inline results |
| Visualization fragmented | Amira (3D) + Prism (charts) separately | Unified 2D/3D viz in one workspace |
| No reproducible pipeline | Manual steps, hard to replicate | Notebook-based workflows, shareable via marketplace |
| OARSI scoring subjective | Blinded manual histology scoring | AI-assisted scoring with consistency checks |

### Target Workflow in Platform

```
Upload uCT DICOM → Auto-segment (watershed/AI) → 3D model
    → AI auto-align orientation (3-axis correction)
    → Measure geometric indices (femoral W/L ratio, tibial IIOC H/W ratio)
    → Statistical analysis (ANOVA, ROC, Bland-Altman, ICC)
    → Generate figures (3D renders, charts, tables)
    → Write paper with inline citations and embedded figures
    → Share segmentation workflow via marketplace
```

## Core Capabilities

| Capability | Description |
|---|---|
| **Python Execution** | Run arbitrary Python (pandas, numpy, scipy, scikit-learn) in-browser via Pyodide (MVP), with server-side Jupyter kernels for heavy compute (Phase 2) |
| **N-D Data Visualization** | 2D charts (Plotly), 3D surfaces/volumes, 4D/5D time-series and multi-channel medical imaging |
| **Interactive 3D Canvas** | WebGL-based viewer for 3D biomedical data with segmentation overlays, rotation, slicing, measurement tools |
| **ML Model Execution** | Run models like MedSAM3 for segmentation via serverless GPU (Modal/Replicate) |
| **Skill Marketplace** | Browse, share, and import biomedical workflows, analysis scripts, and tool configurations |
| **Paper Writing** | AI-assisted scientific paper drafting with citation management, figure integration, and collaborative editing |

## What We Keep (Existing Infrastructure)

The following Meridian systems are **domain-agnostic** and reused as-is:

- **Auth** — JWT + Supabase OAuth, per-user resource isolation
- **Projects** — Generic containers (now: research projects instead of novels)
- **Documents** — Hierarchical folder/file tree (now: papers, notebooks, datasets, configs)
- **Threads/LLM** — Multi-turn AI conversations with tool calling and streaming
- **Collaboration** — Real-time Yjs editing, proposal accept/reject workflow
- **Billing** — Credit system, token-based pricing
- **Skills/Personas** — Extensible AI behaviors (replace fiction personas with biomedical ones)
- **Tool Registry** — Pluggable tool execution pipeline (add Python execution tools)

## What Changes

### Domain Layer Changes

| Area | From (Fiction) | To (Biomedical) |
|---|---|---|
| **Personas** | writing-coach, editor, brainstorm | data-analyst, stats-reviewer, methods-writer, literature-reviewer |
| **Skills** | prose-style, character-dev | python-analysis, citation-lookup, figure-gen, statistical-methods |
| **File Types** | .md (chapters) | .md (papers), .py (scripts), .ipynb (notebooks), .nii/.dcm (imaging) |
| **Metadata** | wordCount | dataShape, columnTypes, fileSize, modality |
| **System Prompts** | Writing guidance | Biomedical analysis guidance, statistical rigor |

### New Backend Domains

#### 1. `compute` — Python Execution Service

Manages code execution sessions, input/output routing, and result persistence.

```
internal/domain/compute/
  interfaces.go    — ExecutionService, SessionManager
  types.go         — ExecutionRequest, ExecutionResult, Session, OutputType

internal/service/compute/
  pyodide_bridge.go   — Coordinates browser-side Pyodide execution via tool results
  jupyter_service.go  — (Phase 2) Server-side Jupyter kernel management
  modal_service.go    — (Phase 2) GPU model execution via Modal.com
```

**MVP (Pyodide)**:
- Frontend runs Pyodide in a Web Worker
- LLM tool `execute_python` sends code to frontend via SSE event
- Frontend executes in Pyodide, returns result via POST
- Results (text, images, dataframes) stored as turn blocks

**Phase 2 (Jupyter)**:
- Server-side Jupyter kernel per session
- WebSocket connection for interactive execution
- Shared filesystem for data access
- GPU support via Modal for heavy models

#### 2. `dataset` — Data Management

Manages dataset upload, storage, metadata extraction, and access.

```
internal/domain/dataset/
  interfaces.go    — DatasetStore, DatasetReader, MetadataExtractor
  types.go         — Dataset, DatasetVersion, ColumnSchema, DataModality

internal/service/dataset/
  dataset_service.go     — CRUD, versioning, access control
  metadata_service.go    — Auto-extract schema, stats, previews
  storage_service.go     — S3/Supabase Storage integration
```

**Supported formats (MVP)**: CSV, TSV, JSON, Parquet, Excel
**Phase 2**: NIfTI, DICOM, FASTA/FASTQ, BAM/SAM, AnnData (.h5ad)

#### 3. `marketplace` — Skill Marketplace

Extends existing skill system with publishing, discovery, and community features.

```
internal/domain/marketplace/
  interfaces.go    — MarketplaceStore, PublishService
  types.go         — PublishedSkill, SkillCategory, Rating, Installation

internal/service/marketplace/
  publish_service.go     — Validate, package, publish skills
  discovery_service.go   — Search, filter, recommend
  install_service.go     — One-click import into project
```

### New Frontend Features

#### 1. Notebook View (`features/notebook/`)

A Jupyter-like notebook interface built on CodeMirror.

- **Code cells**: Python with syntax highlighting, Shift+Enter to execute
- **Output cells**: Text, tables (DataFrame), Plotly charts, images
- **Markdown cells**: Existing CodeMirror editor (reuse)
- **Pyodide runtime**: Web Worker with package management
- **Variable inspector**: Show active variables and their types/shapes

#### 2. Visualization Panel (`features/visualization/`)

Pluggable visualization system for analysis outputs.

- **2D**: Plotly.js (charts, heatmaps, scatter plots) — renders from Pyodide output
- **3D Canvas**: React Three Fiber for interactive 3D (MVP), VTK.js for medical volumes (Phase 2)
- **Gallery**: Saved visualizations linked to analysis sessions

#### 3. Dataset Browser (`features/datasets/`)

Upload, browse, and preview datasets.

- **Upload**: Drag-and-drop with progress, auto-metadata extraction
- **Preview**: First N rows, column types, basic stats
- **Schema view**: Column names, types, nulls, distributions
- **Access in code**: `load_dataset("my-dataset")` in Pyodide

#### 4. Marketplace UI (`features/marketplace/`)

Browse and install community skills/workflows.

- **Browse**: Categories (genomics, imaging, clinical, statistics)
- **Skill cards**: Name, description, author, install count, rating
- **Install**: One-click add to project
- **Publish**: Package project skill for marketplace

#### 5. Paper Writing Mode (`features/paper/`)

Enhanced editor for scientific papers.

- **Structure templates**: IMRaD, review article, case study
- **Citation insertion**: Search PubMed/CrossRef, insert formatted references
- **Figure embedding**: Link analysis outputs as numbered figures
- **Export**: PDF via LaTeX, DOCX via Pandoc (existing infra)

### New Tools (LLM Tool Registry)

#### General Tools

| Tool Name | Description | Backend/Frontend |
|---|---|---|
| `execute_python` | Run Python code, return stdout/plots/dataframes | Frontend (Pyodide) |
| `load_dataset` | Load a dataset into the Python environment | Frontend (Pyodide) |
| `create_visualization` | Generate a Plotly/matplotlib visualization | Frontend (Pyodide) |
| `search_pubmed` | Search PubMed for papers by query | Backend (API call) |
| `search_crossref` | Search CrossRef for DOIs and citations | Backend (API call) |
| `run_model` | Execute a biomedical model (MedSAM3, etc.) | Backend (Modal) |
| `insert_citation` | Add a citation to the current document | Backend (doc edit) |
| `insert_figure` | Embed a visualization output as a figure | Backend (doc edit) |

#### uCT/Imaging-Specific Tools (via skills + Python)

| Tool Name | Description | Implementation |
|---|---|---|
| `segment_bone` | Watershed/threshold-based bone segmentation from DICOM | Python (SimpleITK) |
| `auto_align_orientation` | AI-assisted 3-axis orientation correction using anatomical landmarks | Python (scikit-image + landmark detection) |
| `measure_geometric_index` | Calculate femoral W/L ratio, tibial IIOC H/W ratio from segmented model | Python (numpy) |
| `compute_roc` | ROC analysis with AUC, sensitivity/specificity, cutoff values | Python (sklearn) |
| `bland_altman_plot` | Inter-rater reproducibility analysis with ICC | Python (statsmodels) |
| `render_3d_model` | Generate interactive 3D visualization of segmented bones | Frontend (R3F/VTK.js) |

### New API Endpoints

```
# Datasets
POST   /api/datasets                        — Upload dataset
GET    /api/datasets                         — List datasets (project scoped)
GET    /api/datasets/{id}                    — Get dataset + metadata
GET    /api/datasets/{id}/preview            — Preview first N rows
DELETE /api/datasets/{id}                    — Delete dataset

# Compute
POST   /api/compute/sessions                — Create execution session
POST   /api/compute/sessions/{id}/execute    — Execute code (server-side, Phase 2)
GET    /api/compute/sessions/{id}/status     — Session status

# Marketplace
GET    /api/marketplace/skills               — Browse published skills
GET    /api/marketplace/skills/{id}          — Skill detail
POST   /api/marketplace/skills               — Publish a skill
POST   /api/marketplace/skills/{id}/install  — Install to project
GET    /api/marketplace/categories           — List categories

# Citations
GET    /api/citations/search                 — Search PubMed/CrossRef
POST   /api/citations                        — Save citation to project
```

## Database Changes

### New Tables

```sql
-- Dataset storage and metadata
CREATE TABLE datasets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    file_type TEXT NOT NULL,          -- csv, parquet, nifti, dicom, etc.
    storage_path TEXT NOT NULL,        -- S3/Supabase Storage path
    size_bytes BIGINT NOT NULL,
    metadata JSONB DEFAULT '{}',      -- column schemas, stats, modality
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

-- Marketplace: published skills
CREATE TABLE published_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    category TEXT NOT NULL,           -- genomics, imaging, clinical, statistics
    content TEXT NOT NULL,            -- skill markdown content
    version TEXT NOT NULL DEFAULT '1.0.0',
    install_count INT NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}',     -- tags, dependencies, examples
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Marketplace: installations
CREATE TABLE skill_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    published_skill_id UUID NOT NULL REFERENCES published_skills(id),
    installed_version TEXT NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, published_skill_id)
);

-- Citations for paper writing
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
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Modified Tables

```sql
-- Add new file types to documents
-- file_type enum: add 'python', 'notebook', 'dataset_ref', 'visualization'

-- Add dataset references
ALTER TABLE documents ADD COLUMN dataset_id UUID REFERENCES datasets(id);
```

## Implementation Phases

### Phase 1: Foundation (MVP)
**Goal**: Researcher can upload CSV data, run Python analysis, and see results — all in one workspace.

1. Replace fiction personas/skills with biomedical ones (data-analyst, stats-reviewer, methods-writer)
2. Pyodide integration (Web Worker + `execute_python` tool)
3. Plotly output rendering in thread view (2D charts, bar plots, ROC curves)
4. Dataset upload + CSV/JSON/Excel preview (supports supplemental tables like S1-S3)
5. Basic notebook view (code cells + output)
6. Statistical analysis tools (ANOVA, t-test, ROC, Bland-Altman via scipy/sklearn)
7. PubMed/CrossRef citation search tool
8. Update landing page / branding

**Validation**: Can reproduce the paper's statistical analysis (Tables 1-2, ROC curves in Figs 2G, 3E, 4A-B) from uploaded supplemental data.

### Phase 2: 3D Visualization + DICOM
**Goal**: Researcher can upload uCT DICOM, view 3D bone models, and take measurements.

1. DICOM file upload + metadata extraction (Scanco VivaCT format)
2. React Three Fiber 3D canvas with rotation, zoom, pan
3. Volume rendering of uCT data (threshold-based, matching Scanco threshold 220/270/320)
4. Interactive ruler/measurement tool on 3D models
5. Bone segmentation via Python (SimpleITK watershed, threshold-based)
6. Ortho slice viewer (coronal/sagittal/axial planes)
7. Dataset browser with column statistics and distribution plots

**Validation**: Can load a uCT DICOM dataset, segment femur/tibia/patella, measure femoral W/L ratio and tibial IIOC H/W ratio, matching Amira-derived values.

### Phase 3: AI-Assisted Analysis + GPU Compute
**Goal**: AI automates tedious steps (orientation correction, landmark detection, segmentation refinement).

1. AI-powered 3-axis image orientation correction (the paper's stated future direction)
2. Anatomical landmark detection (intercondylar notch, growth plate, condyle edges)
3. Automated geometric index extraction from segmented models
4. Server-side Jupyter kernel service (for large DICOM stacks that exceed Pyodide memory)
5. Modal.com integration for GPU models (MedSAM3 segmentation)
6. Segmentation overlay on 3D canvas (bone vs cartilage vs osteophyte)
7. NIfTI file support + VTK.js medical volume viewer

**Validation**: Can auto-orient a tilted uCT scan and extract geometric indices without manual intervention, matching blinded operator results within ICC > 0.85.

### Phase 4: Marketplace + Paper Writing
**Goal**: Researcher can share their analysis workflow and draft papers with integrated figures.

1. Skill publishing and discovery API
2. Marketplace browse/install UI (categories: musculoskeletal, imaging, statistics, etc.)
3. Pre-built skill: "OA Geometric Index Analysis" (the paper's full pipeline as a shareable workflow)
4. Citation management and bibliography generation (PubMed/CrossRef integration)
5. Figure embedding from analysis outputs (link Plotly charts + 3D renders to paper sections)
6. Paper export (LaTeX PDF, DOCX via Pandoc)

**Validation**: Full paper workflow — from data upload to submitted manuscript with inline figures and formatted references.

### Phase 5: Polish + Scale
1. Collaborative notebook editing (Yjs on code cells)
2. Dataset versioning and provenance tracking
3. Workflow templates (OA analysis, bone microarchitecture, histomorphometry)
4. Execution history and reproducibility (re-run any notebook state)
5. Community ratings, reviews, and forking of marketplace skills
6. Batch processing (run same analysis across multiple specimens)

## Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| MVP Python runtime | Pyodide (browser WASM) | Zero infra, instant start, covers pandas/numpy/scipy/sklearn. Upgrade to Jupyter for GPU/large data. |
| 2D visualization | Plotly.js | Native Python→JSON bridge, interactive, well-documented |
| 3D visualization | React Three Fiber (MVP) → VTK.js (Phase 3) | R3F for general 3D; VTK.js when medical imaging features needed |
| GPU compute | Modal.com | Serverless, pay-per-second, scales to zero, easy Python deploy |
| Citation API | PubMed E-utilities + CrossRef REST | Free, comprehensive, well-documented |
| Dataset storage | Supabase Storage (MVP) → S3 (scale) | Already integrated, good for MVP sizes |
| Marketplace backend | Extend existing skill system | Already have ProjectSkill CRUD, just add publishing layer |
