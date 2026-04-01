# Biomedical MVP — Requirements

## Customer
Dad (Yao Lab, University of Rochester). Musculoskeletal researcher analyzing uCT scans of murine knee joints for OA severity assessment.

## Problem
"I've kinda given up on [CT image processing]." The image processing pipeline (DICOM → segmentation → 3D model → measurements) is manual, slow, and requires expensive software (Amira). Stats analysis requires bouncing between GraphPad Prism and R. Paper writing is disconnected from analysis.

## MVP Goal
An AI agent that autonomously processes uCT scans end-to-end: upload DICOMs → segment bones → validate with researcher at checkpoints → measure geometric indices → run statistics → generate figures → draft paper sections.

## Core Requirements

### 1. execute_python tool (Daytona)
- New ToolExecutor following existing interface
- Runs Python in Daytona CPU sandbox (not Pyodide — SimpleITK requires native C++)
- Packages: SimpleITK, scipy, numpy, pandas, scikit-image, plotly, matplotlib, pydicom, trimesh
- Persistent sandbox per project, auto-stops on idle
- Progress streamed via existing WebSocket

### 2. Inline result rendering in chat
- Plotly charts (JSON → interactive chart in turn block)
- Matplotlib images (PNG base64 → image in turn block)
- DataFrames (HTML table in turn block)
- Text output (stdout/stderr)
- Mesh file download link (STL/OBJ export as byproduct)

### 3. Basic 3D viewer
- React Three Fiber canvas component
- Receives mesh data from Python (marching cubes → vertices + faces + labels)
- Color-coded by label (femur=blue, tibia=green, patella=purple, osteophyte=red)
- Rotate, zoom, pan
- Toggle structures on/off
- Purpose: researcher validates segmentation ("that's a sesamoid, not an osteophyte")

### 4. Dataset upload
- Drag-and-drop DICOM stacks into Supabase Storage
- Metadata extraction on upload (scanner info, resolution, slice count)
- Files accessible from Daytona sandbox
- datasets table in DB (project-scoped)

### 5. Biomedical agent profile
- Single .agents/agents/data-analyst.md
- Domain knowledge: uCT processing, bone morphometry, watershed segmentation, geometric indices (femoral W/L, tibial IIOC H/W), statistical methods
- Uses execute_python as primary tool
- Shows work at each step, asks for validation at checkpoints

### 6. Daytona sandbox lifecycle
- One persistent sandbox per project
- Auto-stops after idle timeout
- DICOMs pulled from Supabase Storage on session start
- Packages pre-installed

## NOT in MVP
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

## Existing Infrastructure to Reuse
- Tool registry + ToolExecutor interface (backend)
- WebSocket protocol + binary frame support (backend)
- Chat/thread UI with streaming (frontend)
- Project/document tree (backend + frontend)
- PersonaCatalog + skill resolution (backend)
- Two-panel layout (frontend)
- Auth, billing, Supabase Storage integration
