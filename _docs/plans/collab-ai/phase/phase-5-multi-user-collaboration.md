---
detail: minimal
audience: developer, architect
---
# Phase 5: Multi-User Collaboration

**Status:** Future
**Priority:** Medium
**Purpose:** Extend Yjs-based editing to multiple human co-editors. Native to Yjs — no CRDT migration needed.

## Entry Conditions

- Phase 1-4 are stable in production.
- Phase 1-4 spec contracts remain unchanged unless explicitly versioned.

## Key Simplification (Yjs)

Multi-user is **native to Yjs** from the start:
- Awareness/presence/cursors work from Phase 1 via `y-protocols/awareness` (opaque relay through Go).
- No CRDT migration or re-evaluation needed (unlike the OT plan).
- Conflict resolution is built-in (CRDT guarantee).
- The main new work is membership, permissions, and UX polish.

## Architectural Readiness (from Phase 1-4)

Phase 1-4 already provide the foundations for multi-user:
- **`DocumentBroadcaster` multi-client fan-out** — designed for N clients per document from the start (no single-user assumption in the interface).
- **Awareness relay** — opaque binary forwarding of `y-protocols/awareness` messages between all connected clients (Phase 1).
- **User-agnostic interfaces** — `DocumentStore` and `DocumentBroadcaster` operate on `docID` only (no single-user assumption). Multi-user requires adding `userID` to `Subscribe` for per-user identity tracking, adding per-user cursor state to awareness, and enforcing role-based permissions on mutations.
- **Permissions as separate domain** — auth is JWT-based with `CanAccessDocument` check; role-based access (owner/editor/viewer) layers on top without restructuring the collab domain.

## In Scope

- Membership and permission model for shared projects.
- Multi-client presence UX polish (cursor colors, user labels, typing indicators).
- Conflict ergonomics for multiple human writers (semantic review for large divergences).
- Role-based access control (owner/editor/viewer) enforcement.

## Retained Requirements (From Legacy Future Notes)

- Collaboration entrypoints: invite collaborators into shared threads/projects.
- Presence basics: who is online, who is typing, optional per-user visual identity.
- Minimum permission tiers: read, write, admin (or owner/editor/viewer equivalent).
- Optional activity feed for auditability and team awareness (deferred if it adds UI noise).

## Out of Scope

- Reworking core single-writer reliability model.

## Deliverables

- Multi-user session model and permission contracts.
- Role-based read-only enforcement (viewer cannot edit, `readOnlyChanged` event for permission changes).
- Presence UX polish beyond Phase 1 baseline (user avatars, cursor labels via `y-codemirror.next`).
- Shared-project safety model aligned with project-owned artifact instances.
- `DocumentBroadcaster` scaling (swap in-memory -> Redis pub/sub if multi-instance needed).
- Frontend collaboration capabilities remain package-owned (`@meridian/cm6-collab` plus awareness extensions), with app layer as orchestration only.

## Dependencies

- Phase 1-4 contracts and invariants.
- CM6 package boundary contract from `_docs/plans/collab-ai/spec/cm6-library-model.md`.

## Implements Specs

- `_docs/plans/collab-ai/spec/storage-model.md` (Yjs state boundary remains intact)
- `_docs/plans/collab-ai/spec/api-events-contract.md` (event/error model extension for permissions)
- `_docs/plans/collab-ai/spec/cm6-library-model.md` (frontend package boundaries for presence/cursors/permissions UX)

## Exit Criteria

- Multiple human editors can edit simultaneously with predictable CRDT merge behavior.
- Permission boundaries are enforceable server-side (viewer cannot write).
- Writer focus UX remains stable under collaboration load.
- Multi-user editor behavior is delivered through `@meridian/cm6-collab` package APIs, without app-local reimplementation of collab state logic.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/agents/fb-artifact-templates-and-project-instances.md`
- `_docs/plans/collab-ai/spec/cm6-library-model.md`
