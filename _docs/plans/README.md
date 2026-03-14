# Implementation Plans

This directory contains implementation plans for features in development or ready to be built.

## Plan Map (High-Level)

- `collab-ai/` - Canonical collaboration program (architecture intent, technical specs, and phased rollout). Read `collab-ai/README.md` first, then go into `spec/`, `phase/`, or focused plan docs.
- `references/` - Internal-linking, document references, and context-window/compaction planning. There is no sub-README, so start with the highest-level current plan in this folder before reading deeper dependencies.
- `import/` - File import strategy and format handling. Start with the top plan in this folder to understand scope boundaries before touching implementation docs.
- `agents/` - Agent/skills product plans and related archives. Read `agents/agents.md` first to understand ownership and active tracks in this domain.
- `meridian-channel/` - Orchestration/runtime planning for the meridian-channel track (active strategy/risk docs plus archived design/implementation slices). Start with `meridian-channel/strategic-direction.md`, then `meridian-channel/risk-and-gaps.md`.
- `ws-transport-v2/` - Per-document WebSocket refactor + two-lane transport. Supersedes Phase 4.6. Read `ws-transport-v2/README.md` first.
- `collab-data-model-v2/` - Collaboration data model evolution: one canonical Y.Doc, ephemeral projection, immediate undoable actions, thread-level undo/reapply. Read `collab-data-model-v2/README.md` first.
- `local-bridge/` - Staged local-bridge rollout plans. Read `local-bridge/README.md` first, then follow stage files in order.
- `_archive/` - Archived or superseded standalone plans retained for history and cross-reference only; do not treat as active implementation intent.

## Canonical / Legacy Root Plans

- `fb-realtime-collab-editing.md`
- `fb-document-history-v1.md`
- `fb-event-driven-refresh-framework.md`
- `fb-tree-ai-suggestions-banner-accept-all.md`

## Conventions

Every plan should include a `**Status:**` field near the top:
`draft | approved | in-progress | done | archived`.

Plan lifecycle and execution rules are defined in `AGENTS.md` / `CLAUDE.md`.
