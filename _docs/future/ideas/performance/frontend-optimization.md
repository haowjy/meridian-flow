---
status: future
priority: medium
featureset: performance
detail: planning
audience: developer
---

# Frontend Performance & Optimization Questions

This document tracks frontend performance and optimization topics to explore after MVP ships.

## Lazy Loading & Prefetch
- Whether to prefetch visible/likely‑to‑open documents during bootstrap.
- UX for first‑open latency and whether to tune skeleton timing.

## Auto‑Eviction (Cache)
- Exact thresholds and hysteresis (trigger percentage and target percentage).
- Batch size for deletions to avoid UI stalls.
- Protection rules beyond active/unsynced/recent (e.g., pinned).
- Re‑fetch behavior when opening an evicted doc while offline.

## Quota Monitoring & Debuggability
- What to show in a debug/settings panel about storage usage and evictions.
- Whether to sample storage checks or cache usage estimates.

## Sync Queue Management
- Behavior when the queue grows very large.
- Whether to batch operations or keep one‑by‑one.
- Retention/cleanup policy for very old failed items.

## Multi‑Tab Behavior
- Handling concurrent edits across tabs.
- Any soft lock or indicator policy.
- Handling storage version changes from other tabs.

## Eviction Detection
- Whether to detect browser‑driven cache eviction explicitly.
- Messaging strategy (if any) for recovery in advanced modes.

## Performance at Scale
- Virtualization thresholds for very large trees.
- Pagination or incremental loading strategies.
- Handling very large documents.

## Observability
- Minimal metrics worth tracking (retry counts, time‑to‑sync, queue sizes) and where to expose them.

## Converters & Formats
- Coverage of Markdown features vs. editor features (tables, callouts, task lists, footnotes).
- Handling of front‑matter or metadata blocks.
- Stability of round‑trip MD ↔︎ TipTap for complex nodes.
- Import/export to other formats (HTML, PDF, Docx) and where those live.

## Assets (Images)
- Choose object storage provider and upload mechanism (pre‑signed URLs vs. proxy).
- Client‑side transforms: compression, orientation fix, thumbnails; worker strategy.
- Asset metadata model (hash, size, dimensions, formats, status) and dedupe policy.
- Export modes: link‑only vs. bundled assets (images subfolder) and link rewriting.
- Offline handling: protect unsynced assets; eviction order for originals vs. thumbnails.
- Security: content‑type enforcement, sanitization, optional AV scanning server‑side.

## Image Workflows (Upload, Resolve, Export)
- “Secret S3” uploads: decide pre‑signed URL vs. backend proxy; bucket/folder structure; ACL (private + signed access) and CDN domain.
- Local cache: store originals + thumbnails as Blobs in IndexedDB; size limits and when to compress; protect unsynced assets from eviction.
- Link resolution: Markdown stores stable asset references; renderer resolves to local blob URL if present, otherwise remote URL.
- Export bundling: support a bundled mode that emits an adjacent `_images/` directory and rewrites Markdown links; define naming scheme (e.g., `_images/<assetId>.<ext>` or path‑mirroring), collision handling, and relative path depth.
- Unsynced during export: choose fallback when remote URL is missing (embed base64 vs. export from local cache into `_images/`).
- Background behavior: upload queue concurrency, network/backoff policy, and progress telemetry; allow manual retry from a debug panel.
- Transcoding policy: JPEG/PNG/WebP choices, quality targets, max dimensions, EXIF strip/rotation; done in a Web Worker.
- Security & validation: MIME/type sniffing, size caps, domain allowlists; server‑side scanning (future) and signed URL expiry rotation.
- Dedupe & IDs: content‑hash IDs to reuse assets across documents; naming stability across exports.
- Metrics: bytes uploaded, upload latency, failure rate, cache hit rate; where to surface (debug only vs. user‑visible).
