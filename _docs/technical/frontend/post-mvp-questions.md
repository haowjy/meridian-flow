---
detail: planning
audience: developer
status: backlog
---

# Post‑MVP Questions & Explorations

This document tracks topics to revisit after the MVP ships. No code decisions are implied here.

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

