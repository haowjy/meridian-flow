---
detail: minimal
audience: developer
---
# Collaboration Spec: Refresh Read-Model Framework

**Status:** In planning  
**Priority:** High  
**Purpose:** Keep writer-facing collab read models fresh without request storms.

## In Scope

- Event-driven refresh intents from SSE and collab events.
- Poll fallback (visible + online + project-open only).
- Coalescing/dedupe/in-flight suppression.
- Debug visibility for queued intents and last refresh timestamps.

## Refresh Targets

- Project tree.
- Proposal review index (pending counts + affected docs).
- Touched-document read model.
- Active document (only when affected).

## Trigger Baseline

- On turn/proposal completion: refresh impacted read models.
- On accept/reject/restore/checkpoint actions: refresh impacted read models.
- Poll every 30s as healing fallback.

Collab proposal event minimums:
- `newProposal` -> refresh proposal lists/status index.
- `proposalStatusChanged` (`rejected|conflicted`) -> refresh proposal lists/status index.
- `proposalRemoved` (accepted + promoted) -> refresh proposal lists/status index + authoritative changeset lists.

## Exit Criteria

- Missed events self-heal without hard refresh.
- No request storm from bursty trigger sources.
- Read models stay coherent across tree/editor/thread surfaces.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/phase/phase-2-history-and-undo.md`
- `_docs/plans/collab-ai/phase/phase-3-ai-proposals-and-review.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
