---
stack: frontend
status: complete
feature: "Offline-First"
detail: minimal
audience: developer
---

# Offline-First

**Persistent offline durability for document saves and tree mutations.**

## Status: ✅ Complete

---

## Overview

- Non-collab document saves persist locally and retry after reconnect/reload.
- Tree snapshots warm-load from IndexedDB before network reconcile.
- Tree rename/move/delete works offline via queued ops with reconnect drain.
- Collab text docs keep local Yjs state via `y-indexeddb`.

## Offline Capability Matrix

| Capability | Behavior Offline | Reconnect Behavior |
|---|---|---|
| Non-collab document save | Failed save persists to `pendingDocumentSaves` (`documentId` last-write-wins) | `persistentSaveDrain` retries on startup, `online`, and periodic tick |
| Tree read | `useTreeStore` loads cached `projectTrees` snapshot immediately | Server tree fetch reconciles cache and UI |
| Tree rename/move/delete (existing entities) | Optimistic UI update + op queued in `pendingTreeOps` | `treeQueueDrain` replays FIFO with coalescing |
| Tree drain conflicts | 404 drops op; 409 stops drain and refreshes tree | Next drain cycle continues after refresh |
| Collab text docs (`.md`, `.markdown`, `.txt`) | Yjs updates persist in `y-indexeddb` | Sync resumes after transport reconnect |
| Thread cache | Not available (network-first by design) | N/A |

## Key Technical Decisions

- Separate Dexie tables for document saves and tree ops (`pendingDocumentSaves` vs `pendingTreeOps`) because semantics differ (last-write-wins vs ordered replay).
- Tree cache is one snapshot row per project (`projectTrees`) because read/write API is whole-tree.
- Reused existing connectivity surfaces (`NetworkStatusBanner`, collab indicators) instead of adding a second connectivity store.
- Detailed rationale and rollout notes: [`_docs/plans/collab-ai/phase/phase-4.7-offline-first.md`](../../plans/collab-ai/phase/phase-4.7-offline-first.md)
