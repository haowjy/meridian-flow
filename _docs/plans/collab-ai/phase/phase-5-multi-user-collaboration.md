---
detail: minimal
audience: developer, architect
---
# Phase 5: Multi-User Collaboration (Future)

**Status:** Future  
**Priority:** Medium  
**Purpose:** Extend the established op/proposal model to human co-editing only after writer-core reliability is stable.

## Entry Conditions

- Phase 1-4 are stable in production.
- CRDT re-evaluation triggers from the main RFC are met.
- Phase 1-4 spec contracts remain unchanged unless explicitly versioned.

## In Scope

- Presence/cursors and multi-client awareness.
- Membership and permission model for shared projects.
- Conflict ergonomics for multiple human writers.

## Retained Requirements (From Legacy Future Notes)

- Collaboration entrypoints: invite collaborators into shared threads/projects.
- Presence basics: who is online, who is typing, optional per-user visual identity.
- Minimum permission tiers: read, write, admin (or owner/editor/viewer equivalent).
- Optional activity feed for auditability and team awareness (deferred if it adds UI noise).

## Out of Scope

- Reworking core single-writer reliability model.

## Deliverables

- Multi-user session model and permission contracts.
- Presence transport and UI affordances.
- Shared-project safety model aligned with project-owned artifact instances.

## Implements Specs

- `_docs/plans/collab-ai/spec/storage-model.md` (authoritative/proposal boundary remains intact)
- `_docs/plans/collab-ai/spec/api-events-contract.md` (event/error model extension)
- `_docs/plans/collab-ai/spec/refresh-read-model-framework.md` (presence/read-model freshness)

## Exit Criteria

- Multiple human editors can edit simultaneously with predictable conflict behavior.
- Permission boundaries are enforceable server-side.
- Writer focus UX remains stable under collaboration load.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/agents/fb-artifact-templates-and-project-instances.md`
