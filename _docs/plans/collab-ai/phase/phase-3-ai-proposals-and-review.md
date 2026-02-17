---
detail: minimal
audience: developer
---
# Phase 3: AI Proposals + Writer Review

**Status:** Complete (Feb 17, 2026)
**Priority:** High
**Purpose:** Replace marker-based AI edits with Yjs update buffer proposals that keep writers in control.

## In Scope

- Proposal schema and lifecycle (`proposed`, `accepted`, `rejected` — terminal statuses retained indefinitely as permanent audit records).
- Yjs update buffer approach: AI generates edits as Yjs updates, held until writer accepts.
- Merge-based review UX using `@codemirror/merge` (no marker bytes in document text).
- Accept = `Y.applyUpdate(mainDoc, bufferedUpdate)` + mark `status='accepted'` — Yjs handles merge automatically.
- Reject = discard buffered update, mark proposal row rejected.
- All proposal operations over single WebSocket (no HTTP proposal endpoints).
- Group accept flow with deterministic order.
- Auto-accept configuration (tri-state cascade: agent -> project -> user -> system default).
- Two-view model: AI sees proposals as applied (via `documents.ai_content`), writer sees diff decorations (via `documents.content`).
- Project-level review surfaces (counts/lists, jump-to-affected-doc).
- Prose-first review rendering quality (readable chunking, low-noise diffs).
- Writer timeline integration with origin filters.

## Out of Scope

- Multi-agent ranking/arbitration policy details (Phase 4).
- Multi-user cursors/presence (available from Phase 1).

## Canonical Data Rules

- Proposals are non-authoritative until accepted.
- Accept path applies the Yjs update buffer to the main `Y.Doc`, then marks proposal `status='accepted'` (terminal status, retained indefinitely).
- **Proposal lifecycle events (create/accept/reject) trigger `ai_content` recomputation** — ensures `documents.ai_content` always reflects doc + all current pending proposals.
- AI search uses `documents.ai_content` column (the AI view with pending proposals applied).
- No rebase step needed — Yjs CRDTs merge regardless of intervening changes.
- Conflict detection is **semantic** (does the result make sense?) not **mechanical** (did positions shift?).
- Accept/reject actions flow over WebSocket (not HTTP), with idempotency keys in WS messages.
- Accept and group-accept requests are idempotent by contract.
- Undo/redo for accepted AI edits uses `Y.UndoManager` like any other edit.
- Auto-accept bypasses the review step when configured, but the writer can still undo.

## Deliverables

- `collab_document_edit_proposals` table (with `status IN ('proposed', 'accepted', 'rejected')`).
- Proposal create via Go service (AI agent internal call), broadcast `proposal:new` via WS.
- Accept/reject via WS JSON frames (`proposal:accept`, `proposal:reject`).
- Group-accept via WS JSON frame (`proposal:groupAccept`) with per-proposal outcome response.
- `collab_request_idempotency` table + idempotency-key validation/replay logic.
- Auto-accept resolution logic (agent -> project -> user -> system cascade).
- Frontend CM6 library packaging for proposal/review:
  - `@meridian/cm6-collab` proposals module for proposal state/events/commands (from WS JSON frames, not HTTP).
  - `@meridian/cm6-collab` review module for `@codemirror/merge` review integration.
  - Host app components and hooks consume package APIs (no proposal-state business logic duplication).
- Tree-level writer review entrypoint for pending AI changes.
- Review presentation rules that favor sentence/paragraph readability over fragmented character diffs.

## Dependencies

- Phase 1 Yjs transport.
- Phase 2 history/undo invariants.
- `_docs/plans/collab-ai/spec/api-events-contract.md` for WS proposal message contracts.
- `_docs/plans/collab-ai/spec/cm6-library-model.md` for frontend package boundaries.

## Implements Specs

- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/cm6-library-model.md`

## Exit Criteria

- Writers can review multiple AI proposals without text corruption.
- Accepting proposals applies Yjs update cleanly even after user edits (CRDT merge).
- Rejecting proposals discards update without side effects.
- Accepted proposals are marked terminal `status='accepted'`, retained indefinitely as permanent audit records.
- Auto-accept applies proposals immediately when configured, writer can undo.
- Project-wide pending AI changes are visible without opening each document.
- Group-accept response is deterministic (`accepted|skipped`) and stable under retries.
- Unauthorized users cannot mutate proposal state (Phase 5 extends this to viewer-role enforcement).
- Writers can undo accepted AI changes through `Y.UndoManager` (no AI-only undo path).
- Proposal/review behavior is delivered through `@meridian/cm6-collab` package (proposals + review modules), with host hooks limited to orchestration.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/cm6-library-model.md`
