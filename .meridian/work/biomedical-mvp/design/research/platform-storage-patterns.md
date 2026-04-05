# Platform Storage Patterns: Mixed Text + Binary File Systems

**Research date:** 2026-04-05  
**Context:** Meridian filesystem redesign — evaluating how production platforms organize backend storage when text documents and binary files coexist in one user-facing tree.

---

## Summary

Every major platform converges on the same fundamental split: **text/structured content lives in a database or source-controlled text files; binary/large files live in object storage (S3/GCS)**. The difference between platforms is how they present a unified tree over these two backends and how compute workloads access the files.

| Platform | Text content | Binary files | Unified tree via | Compute access |
|----------|-------------|--------------|-----------------|----------------|
| Jupyter (local) | Filesystem (`.ipynb` JSON) | Filesystem | ContentsManager REST API | Direct filesystem via kernel process |
| Jupyter (S3/cloud) | Object storage (`.ipynb` as JSON blob) | Object storage | ContentsManager abstraction | Object storage API or pre-mounted paths |
| Deepnote | Object-backed `/work` NFS mount | GCS/S3 (mounted or copied) | Unified `/work` directory | Direct path access in kernel; copy to `/tmp` for perf |
| Google Colab | Google Drive (`.ipynb` as Drive file) | Drive or GCS | Drive FUSE mount at `/content/drive/` | Local VM path after mount |
| Notion | PostgreSQL (block content) | S3 (file attachments) | Block tree API | API only (no direct compute) |
| Observable (hosted) | Postgres/proprietary store | CDN-hosted blobs (50 MB cap) | `FileAttachment()` API | Browser-side async fetch |
| Observable (Framework) | Markdown + JS files on disk | Files in `src/` | Static build pipeline | Data loaders at build time |

---

## 1. Jupyter — Contents API

### Architecture
Jupyter's `ContentsManager` is the canonical example of the "abstract filesystem over any backend" pattern. It defines a pluggable interface that translates Jupyter's file operations into backend-specific storage operations.

**Default implementation:** Local filesystem. Notebooks are `.ipynb` JSON files; binaries are raw files. Everything lives on the server's disk.

**S3/cloud implementations (s3contents, etc.):** The `ContentsManager` is swapped out for an S3-backed one. The interface stays identical — Jupyter's UI never knows it's talking to S3. Notebooks are stored as JSON blobs keyed by path prefix. Binary files are stored as raw S3 objects.

### Where text content lives
- Local: Flat files on disk (`.ipynb` JSON format)
- Cloud: JSON blob in S3/GCS bucket at a configured key prefix
- The notebook format embeds cell source and outputs in JSON — everything is in one file

### Where binary files live
- Same backend as notebooks — no distinction at the ContentsManager level
- Large binary files are expensive via object storage APIs (no random access, full object reads)
- S3ContentsManager does not cache or chunk: the full binary blob is fetched on open

### Unified tree presentation
- The `GET /api/contents/<path>` REST API presents a virtual directory tree
- S3 key prefixes are mapped to directory paths (flat key-value → tree illusion)
- File model has a `type` field: `"notebook"`, `"file"`, `"directory"`
- For notebooks: content is inline JSON; for files: content is base64-encoded blob or omitted if `content=0` query param

### How compute accesses files
- The Jupyter kernel runs as a subprocess on the same machine as the server
- Kernel accesses files by **direct filesystem path** — it uses the OS filesystem, not the ContentsManager API
- This is a critical design gap: if notebooks are in S3 but the kernel is on a different machine, the kernel can't `open("mydata.csv")` unless the bucket is separately mounted
- Cloud deployments solve this with FUSE mounts (gcsfuse, s3fs) or by pre-syncing files to the VM on kernel start

### Key failure modes
- **Large binary files:** ContentsManager wasn't designed for them. Uploading a 500 MB file via the REST API encodes it as base64 in JSON — 3× size inflation, no streaming. GitHub issue #5705 (jupyter/notebook) explicitly flags this as unsupported.
- **Path gap:** Kernel sees local filesystem; ContentsManager sees cloud — divergence if not mounted.
- **No content-type routing:** The ContentsManager treats all non-notebook files identically regardless of MIME type. Callers must know what to do with each file.

### Key takeaway for Meridian
Jupyter's pattern maps cleanly: the ContentsManager is exactly the "metadata DB + routing" layer from the proposed design. The critical lesson is that **compute must access the same storage as the metadata layer** — the path gap is the #1 pain point in cloud Jupyter deployments.

---

## 2. Deepnote

### Architecture
Deepnote uses a unified `/work` directory backed by object storage (evolved from NFS in 2021 to GCS-backed as of 2024). This is the most "batteries included" approach — no distinction between notebook files and data files from the user's perspective.

### Where text content lives
- Notebooks stored in `/work` alongside code files
- Object storage backend (GCS bucket managed by Deepnote), presented via FUSE or NFS mount
- Deepnote stores notebook content in their DB as well, for collaboration and versioning features

### Where binary files live
- `/work` — same mount, same bucket. No routing distinction.
- External integrations (S3, GCS, Drive, OneDrive, Dropbox) are mounted at separate paths within the container filesystem
- Mounted buckets appear as real directories; Python code accesses them by path

### Unified tree presentation
- The file browser in the UI reflects the actual `/work` filesystem
- No metadata DB — the filesystem IS the metadata. Path = identity.
- Datasets (shared across projects) are a separate GCS bucket, mounted at a predictable path

### How compute accesses files
- Kernel runs in the same container where `/work` is mounted
- Files accessed by **normal filesystem path** — `pd.read_csv("/work/mydata.csv")` works
- For high-throughput work (training ML models, unzipping), the recommendation is to copy files from `/work` to `/tmp` first, because object storage backends have high latency for small-file operations
- This is the classic FUSE-on-object-storage tradeoff: good for large sequential reads, poor for random access or many small files

### Key failure modes
- **FUSE latency:** Object storage via FUSE has 5–100× higher latency than local NFS for small files or random access
- **Large file performance:** Copying a 500 MB DICOM stack from `/work` to `/tmp` on each kernel start is slow and costs egress
- **No content-type awareness:** The filesystem doesn't know a `.dcm` is different from a `.py` — all routing is by convention

### Key takeaway for Meridian
Deepnote's approach is the simplest UX (one directory, no routing) but creates performance issues with large files. The "copy to `/tmp` before processing" pattern is a workaround for object storage latency that users find confusing. For a biomedical platform with 500 MB DICOM stacks, this is a meaningful pain point.

---

## 3. Google Colab

### Architecture
Colab is an ephemeral VM + Google Drive as persistent storage. The VM is stateless; Drive is the source of truth for notebooks. Data files have no canonical home and must be re-acquired each session.

### Where text content lives
- Notebooks (`.ipynb` files) live in Google Drive, stored in Drive's proprietary format but exposed as `.ipynb`
- Drive handles versioning and sharing — notebook identity is a Drive file ID
- Colab Enterprise (2024) adds managed runtimes with persistent SSD disks (100 GiB default)

### Where binary files live
- **No persistent binary storage** by default. The VM's `/content/` is ephemeral.
- Users mount Google Drive (`drive.mount('/content/drive/')`) to access files — Drive is a general-purpose file store, not a binary-optimized one
- For large data: Google Cloud Storage is the recommended pattern (`gsutil`, `gcsfs`), accessed directly from the VM
- For datasets: Kaggle integration, HuggingFace datasets, or manual re-download each session

### Unified tree presentation
- No unified tree. Users navigate Drive (for notebooks) and the VM filesystem (for data) separately.
- Drive appears at `/content/drive/My Drive/` after mounting — it's a FUSE mount via `google-drive-ocamlfuse` or the Colab-provided drive module
- The notebook file browser only shows the VM's local filesystem, not Drive's full tree

### How compute accesses files
1. **Local VM filesystem** (`/content/`): Fast, ephemeral, accessible by path
2. **Google Drive mount** (`/content/drive/`): Slow for large files (Drive API rate limits), accessible by path
3. **GCS** (`gs://bucket/`): Best performance for large datasets, requires explicit `gsutil cp` or `gcsfs`/`tensorflow.io` for streaming access
4. **Colab's file upload widget**: Uploads to VM filesystem — ephemeral, small files only

The pattern: **pull data into VM at session start, process locally, push results to Drive/GCS at end**

### Key failure modes
- **Session reset loses all data:** Any files in `/content/` disappear. Users lose work constantly.
- **Drive rate limits:** Heavy file access via Drive FUSE triggers quota errors ("Input/output errors")
- **No binary storage strategy:** Colab has no designed answer for 500 MB files — it's a workaround environment
- **Ephemeral dependency installation:** Users must `pip install` every session unless using managed runtimes

### Key takeaway for Meridian
Colab's pattern is what to avoid: no persistent binary storage, no unified tree, session state loss. The lesson is that **the VM and the data store must be decoupled but tightly integrated** — compute is ephemeral, data is not. Colab Enterprise's persistent disks (2024) partially address this but don't solve the fundamental design.

---

## 4. Notion

### Architecture
Notion is the purest example of the **block-as-universal-unit** pattern: everything — text, headings, images, databases, file attachments — is a block in a unified tree. Content routing (text → Postgres, binary → S3) is invisible to the user.

### Where text content lives
- All text block content lives in **PostgreSQL** in a `blocks` table
- Block schema: `{ id, type, properties: { title: [text nodes] }, parent_id, space_id }`
- The `properties.title` field stores rich text as a tree of text nodes with formatting marks
- Postgres is sharded: 96 physical instances (as of 2023), organized by `workspace_id`

### Where binary files live
- File attachments, images, videos, PDFs: stored in **AWS S3**
- URLs are pre-signed with expiration times — clients fetch directly from S3, not through Notion's servers
- Notion-hosted files: `https://s3.us-west-2.amazonaws.com/secure.notion-static.com/...`
- Upload flow: client → Notion API → S3 pre-signed upload URL → client uploads directly to S3
- File blocks in Postgres contain only the S3 URL and metadata (name, size, mime type), not the content

### Unified tree presentation
- The block tree in Postgres IS the unified tree
- A `file` block looks identical to a `paragraph` block from the tree API perspective — it's just a different `type` with a URL in `properties` instead of text
- `loadPageChunk` API returns the entire subtree of blocks for a page; callers render based on `type`
- File attachments participate in the same parent-child tree as text blocks

### How compute accesses files
- No direct compute — Notion is a document editor, not a compute platform
- API access: `GET /v1/blocks/{id}` returns the block including the S3 URL for file blocks
- Automations use the API and then fetch from the S3 URL directly

### Key failure modes
- **S3 URL expiration:** Pre-signed URLs expire (typically 1 hour). Cached URLs break. API callers must re-fetch block data to get fresh URLs.
- **No streaming upload for large files:** Files up to 5 GiB (paid) but multi-part required above 20 MB — the complexity is on the client
- **Text and binary are not interchangeable:** A block with text content can't swap to binary — type changes require delete + create

### Key takeaway for Meridian
Notion's block tree is the best model for the **metadata unification pattern**: text content lives in DB, binary lives in S3, but both are blocks in the same tree. The routing is invisible to consumers of the tree API. **This is exactly the proposed Meridian architecture** — metadata DB provides the tree, content lives in two different backends depending on type. The S3 URL expiration problem is real and must be designed around.

---

## 5. Observable

Observable has two distinct products with different architectures: the original cloud-hosted notebook editor and Observable Framework (open-source, 2024).

### 5a. Observable (Cloud Notebooks)

#### Where text content lives
- Cell source code stored server-side in Observable's proprietary database
- Notebooks are not plain files — they're structured data in Observable's backend
- Observable's database stores cell content, metadata, and version history

#### Where binary files live
- File attachments stored on Observable's CDN infrastructure ("securely hosted on our servers")
- Hard limit: 50 MB per file
- Rolling workspace quota: 1 GB per member per 28 days
- Files are notebook-scoped — a file attached to notebook A is not accessible from notebook B

#### Unified tree presentation
- No tree — Observable's model is notebook-centric, not filesystem-centric
- Within a notebook, `FileAttachment("name.csv")` references an attachment by name
- Static analysis at build time resolves which files a notebook uses; file references must be string literals

#### How compute accesses files
- Browser-side JavaScript only (no server-side kernel)
- `FileAttachment("data.csv").csv()` fetches the file asynchronously from CDN
- Files are never accessed by server-side compute — everything is client-side
- Observable's reactivity model re-fetches as needed

### 5b. Observable Framework (open-source, 2024+)

#### Where text content lives
- Plain Markdown files (`.md`) in a source directory, checked into Git
- Entirely local/VCS-based — no proprietary format or database

#### Where binary files live
- Static files alongside Markdown in `src/`
- At build time, referenced files are content-hashed and copied to `dist/_file/`
- URLs rewritten: `quakes.csv` → `_file/quakes.e5f2eb94.csv` (stable cache key)

#### Unified tree presentation
- The source directory IS the tree — no metadata DB needed for local development
- `FileAttachment("data.csv")` is statically analyzed at build time
- The build pipeline resolves all references and bundles everything into a deployable artifact

#### How compute accesses files (data loaders)
- **Data loaders** are the key innovation: scripts (Python, R, shell, etc.) that run at build time and write their output to stdout
- Framework captures stdout and stores it as a file in `dist/_file/`
- At runtime, the browser fetches the pre-computed file — no backend required
- Pattern: compute runs once at build/deploy time, output is cached as a static file

### Key failure modes
- **Cloud notebooks:** 50 MB file cap is hard; no server-side compute; file scope isolation between notebooks is painful for shared datasets
- **Framework:** Build-time compute only — no live data updates; large generated files bloat the deployment bundle

### Key takeaway for Meridian
Observable Framework's **data loader pattern** is worth studying: run compute at deploy time, cache output, serve statically. For Meridian's biomedical use case (Python analysis scripts that produce derived outputs), this is relevant. However, Observable's file limits and browser-only compute make it a poor direct comparison — the data scale is fundamentally different.

---

## Cross-Platform Pattern Analysis

### The universal split: DB for text, object store for binary

Every platform uses this split, but for different reasons:
- **Text/structured content:** Needs queryability, versioning, collaborative editing (CRDT), search indexing, and relationship tracking. Relational DB is the right home.
- **Binary/large content:** Needs cheap storage, streaming access, direct download without server mediation, and no size limits from column types. Object storage is the right home.

The split is not about text vs binary in the MIME sense — it's about **content that needs to be processed by the platform** (text: indexed, edited, collaborated on) vs **content that is opaque and large** (binary: stored and retrieved wholesale).

### The unified tree abstraction layer

All platforms provide a unified view that hides the text/binary split from users:

| Mechanism | Used by | Properties |
|-----------|---------|------------|
| ContentsManager REST API | Jupyter | Pluggable backends; REST-accessible; binary as base64 |
| Filesystem path (FUSE/NFS) | Deepnote, Colab | Transparent to compute; latency tradeoff with object storage |
| Block tree (Postgres) | Notion | Rich querying; file blocks contain URLs not content |
| `FileAttachment()` API | Observable | Browser-only; static analysis; no filesystem illusion |
| Metadata DB + routing | (Proposed for Meridian) | Most flexible; routes by type at API layer |

### How compute accesses files: three patterns

1. **Direct filesystem (Deepnote, local Jupyter):** Compute sees the same paths as the user. Simple, fast. Breaks when storage is remote unless FUSE-mounted. FUSE on object storage has serious latency issues for small files.

2. **Copy-on-start (Colab, Domino):** Files synced from object store to local VM at session start. Compute sees local paths. Predictable performance, but startup latency and storage duplication.

3. **API-mediated (Notion, Observable):** Compute fetches content via API calls. Most portable, no VM coupling. Latency on every access; doesn't work for legacy code that uses `open()`.

### Large file handling: common failure points

- **Base64 in JSON APIs:** Any system that passes file content through a REST API body (Jupyter ContentsManager, Notion API) hits the 3× size inflation problem. Not viable above ~20 MB.
- **FUSE object storage:** Deepnote's `/work` on GCS has documented poor performance for small files. Recommendation to copy to `/tmp` is a workaround, not a solution.
- **Pre-signed URL expiration:** Notion and similar systems issue time-limited URLs. Long-lived pipelines that cache URLs break silently.
- **Multipart upload UX:** All platforms struggle with the UX of large file uploads. No platform solves this elegantly below the infrastructure layer.

### Recommendations for Meridian's filesystem redesign

Based on the research, Meridian's proposed architecture — metadata DB for the tree, Supabase Storage (S3-compatible) for binary content, Yjs/DB for text — aligns with the industry consensus. Key decisions informed by this research:

1. **The text-in-DB, binary-in-bucket split is correct.** Every platform that handles both types makes this split. Don't fight it.

2. **The metadata DB row should be minimal.** Following Notion's pattern: `id`, `path`, `type/mime`, `parent_id`, `project_id`, `size`, `timestamps`. Don't put content in the metadata row.

3. **Avoid passing large binary content through your API body.** Issue pre-signed upload/download URLs from Supabase Storage. Clients upload/download directly. This is how Notion, S3Contents + JupyterHub, and every scalable platform handles it.

4. **Sandbox (Daytona) should not use the metadata API for file access.** Based on Jupyter/Deepnote patterns, the best approach is to either:
   - Pre-sync project files to the sandbox VM at startup (Colab/Domino pattern) 
   - FUSE-mount the bucket in the sandbox (Deepnote pattern — but note latency issues for DICOM stacks with many small files)
   - Use the S3 API directly in the sandbox Python code (simplest, most portable)
   The DICOM use case (hundreds of files per scan) makes FUSE the riskiest option — exactly the workload Deepnote warns about.

5. **Pre-signed URL expiration is a real operational issue.** Build URL refresh into the client (short-lived URLs, regenerate on access), or use a proxy endpoint that validates permissions and redirects. Don't cache pre-signed URLs.

6. **Don't build a FUSE mount for the MVP.** It's complex to operate and has documented performance issues with small files. Use copy-on-start for the sandbox instead.

7. **"Dataset" is just a folder.** Deepnote, Colab, and Observable all converge here. A dataset is a directory with a well-known path, not a separate domain concept. The Meridian dataset domain can collapse into the filesystem layer.

---

## Sources

- [Jupyter Server Contents API docs](https://jupyter-server.readthedocs.io/en/stable/developers/contents.html)
- [Jupyter Content Architecture](https://docs.jupyter.org/en/latest/projects/architecture/content-architecture.html)
- [s3contents — S3 ContentsManager for Jupyter](https://github.com/danielfrg/s3contents)
- [Deepnote Integrated File System docs](https://deepnote.com/docs/importing-data-to-deepnote)
- [Deepnote Survey of Storage in Data Science Notebook Platforms (2021)](https://medium.com/deepnote/survey-of-storage-in-data-science-notebook-platforms-in-2021-443680bc0af8)
- [Notion: The Data Model Behind Notion](https://www.notion.com/blog/data-model-behind-notion)
- [Notion: Working with Files and Media (API docs)](https://developers.notion.com/docs/working-with-files-and-media)
- [Notion: Building and Scaling Notion's Data Lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)
- [ByteByteGo: Storing 200 Billion Entities — Notion's Data Lake Project](https://blog.bytebytego.com/p/storing-200-billion-entities-notions)
- [Google Colab: Local Files, Drive, Sheets, and Cloud Storage (notebook)](https://colab.research.google.com/notebooks/io.ipynb)
- [Google Colab Enterprise Runtimes docs](https://docs.cloud.google.com/colab/docs/runtimes)
- [Observable: File Attachments documentation](https://observablehq.com/documentation/data/files/file-attachments)
- [Observable Framework: Files](https://observablehq.observablehq.cloud/framework/files)
- [Simon Willison: Interesting Ideas in Observable Framework](https://simonwillison.net/2024/Mar/3/interesting-ideas-in-observable-framework/)
- [Jupyter: Large file upload issue #5705](https://github.com/jupyter/notebook/issues/5705)
