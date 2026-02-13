---
detail: minimal
audience: developer
---
# Phase 3: AI Proposals + Writer Review

**Status:** In planning  
**Priority:** High  
**Purpose:** Replace marker-based AI edits with proposal-first review that keeps writers in control.

## In Scope

- Proposal schema and lifecycle (`proposed`, `rejected`, `conflicted`; accepted proposals are removed after promotion).
- Merge-based review UX using `@codemirror/merge` (no marker bytes in document text).
- Accept/reject endpoints with server-authoritative rebase/apply.
- Group accept flow with deterministic order and stop-on-conflict behavior.
- Project-level review surfaces (counts/lists, jump-to-affected-doc).
- Prose-first review rendering quality (readable chunking, low-noise diffs).
- Writer timeline integration (merged authoritative history with origin filters).
- PUA-marker cleanup/migration from frontend review paths.

## Out of Scope

- Multi-agent ranking/arbitration policy details (Phase 4).
- Multi-user cursors/presence.

## Canonical Data Rules

- Proposals are non-authoritative until accepted.
- Accept path inserts a real authoritative operation, then removes the proposal row in one transaction.
- Review surfaces must read proposal/applied-op state, not legacy `ai_version` state.
- Accept/reject actions are permission-gated (`owner`/`editor` write, `viewer` read-only).
- Accept and group-accept requests are idempotent by contract.
- Undo/restore for accepted AI edits uses the same authoritative changeset history as user edits.

## Deliverables

- `collab_document_edit_proposals` table + indexes.
- Proposal create/accept/reject/conflict handlers.
- Group-accept handler with per-proposal outcome response.
- Accepted-AI changeset discoverability via authoritative changeset query surfaces.
- Frontend merge-review adapter + proposal navigator/actions.
- Tree-level writer review entrypoint for pending AI changes.
- Review presentation rules that favor sentence/paragraph readability over fragmented character diffs.
- Timeline view behavior: default merged history (`user + ai_accepted`) with origin filter controls.

## Dependencies

- Phase 1 operation transport.
- Phase 2 history/undo invariants.
- `_docs/plans/collab-ai/spec/refresh-read-model-framework.md` for read-model freshness.
- `_docs/plans/collab-ai/spec/api-events-contract.md` for proposal/changeset APIs and events.

## Implements Specs

- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/refresh-read-model-framework.md`

## Exit Criteria

- Writers can review multiple AI proposals without text corruption.
- Accepting/rejecting proposals updates state atomically and deterministically.
- Project-wide pending AI changes are visible without opening each document.
- Group-accept response is deterministic (`accepted|conflicted|skipped`) and stable under retries.
- Viewer role cannot mutate proposal state.
- Writers can undo accepted AI changes through normal history/undo flows (no AI-only undo path).

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/refresh-read-model-framework.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
