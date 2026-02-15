---
detail: minimal
audience: developer
---
# Collaboration Spec: Snapshot Strategy

**Status:** Draft
**Purpose:** Alias for snapshot/retention content in `compaction-retention.md`.

This spec was renamed from "Compaction and Retention" to "Snapshot Strategy and Retention" to reflect the Yjs simplification. The canonical content lives in:

> **`_docs/plans/collab-ai/spec/compaction-retention.md`**

See that file for:
- Snapshot triggers (disconnect, N updates, explicit)
- What gets written (Yjs binary to `collab_document_snapshots` table + `documents.yjs_state`)
- First load flow
- Retention policy (proposals retained indefinitely, snapshot + idempotency cleanup)
- Runtime config (env vars)
- Snapshot types (auto, named, pre_restore)
