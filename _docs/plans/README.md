# Implementation Plans

This directory contains implementation plans for features in development or ready to be built. Structure each plan however makes sense for the work — the only requirement is a `**Status:**` field at the top (`draft | approved | in-progress | done | archived`).

## Active Plans

- `fb-realtime-collab-editing.md` - Canonical main plan for Yjs CRDT collaboration + AI proposal model (Go-only backend).
- `collab-ai/README.md` - Focused collaboration plan index and phase map.
- `collab-ai/spec/storage-model.md` - Yjs state persistence, proposal queue schema, Go y-crdt architecture.
- `collab-ai/spec/api-events-contract.md` - Single WebSocket protocol, JWT auth, proposal lifecycle over WS.
- `collab-ai/spec/compaction-retention.md` - Snapshot persistence, retention, cleanup rules.
- `collab-ai/spec/refresh-read-model-framework.md` - Non-collab read-model freshness (proposals via WS, not HTTP).
- `collab-ai/spec/cm6-library-model.md` - Frontend 1-package boundary (`@meridian/cm6-collab` with internal sync/proposals/review modules).
- `collab-ai/phase/phase-1-yjs-sync-and-transport.md` - Yjs CRDT sync + WS transport (Go-only, y-indexeddb offline).
- `collab-ai/phase/phase-2-history-and-undo.md` - Durable history/restore + persistent undo model.
- `collab-ai/phase/phase-3-ai-proposals-and-review.md` - Proposal lifecycle + auto-accept + writer review UX.
- `collab-ai/phase/phase-4-multi-agent-arbitration.md` - Multi-agent proposal admission/arbitration.
- `collab-ai/phase/phase-5-multi-user-collaboration.md` - Future human multi-user extension.
- `fb-wikilinks-and-internal-links.md` - Editor-only: wikilink tokens, CM6 pill rendering, `@` autocomplete, click-to-navigate, LLM prompt guidance.
- `fb-at-references.md` - Thread `@`-file insertion, reference blocks, `BlockTransformer` pipeline, `ReferenceTransformer`. Depends on wikilinks Phase 1.
- `fb-compaction.md` - Context window management: `is_compaction` turns, auto/user/LLM triggers, `conversation_search` tool, tool result summarization. Depends on at-references Phase 2.
- `fb-import-any-file-clean-text.md` - Import “almost any file” as cleaned text with markdown/plaintext/code rendering, plus zip safety + extension policy.
- `fb-skills-safe-packaging-import-and-references-v1.md` - Skills V1.5: safe package contract (`SKILL.md` + `references/**`), references UI, import pipeline, and extensible component policy.
- `agents/fb-artifact-templates-and-project-instances.md` - Templates copied into project-owned instances.
- `agents/archive/fb-project-skills-v1-and-artifact-foundations.md` - Archived project skills plan.
- `agents/fb-remove-document-slugs.md` - ✅ Complete: Documents now use exact path addressing (slug column removed).

## Superseded (Legacy Reference)

- `fb-document-history-v1.md` - Superseded by `collab-ai/phase/phase-2-history-and-undo.md`.
- `fb-event-driven-refresh-framework.md` - Superseded by `collab-ai/spec/refresh-read-model-framework.md`.
- `fb-tree-ai-suggestions-banner-accept-all.md` - Superseded by `collab-ai/phase/phase-3-ai-proposals-and-review.md`.

---

## Conventions

Every plan must include a `**Status:**` field at the top: `draft | approved | in-progress | done | archived`. See `CLAUDE.md` → Plan Lifecycle for the full workflow. Beyond that, structure the plan however makes sense for the work.

## Related Directories

- `_docs/future/` - Future features not yet scheduled for implementation
- `_docs/technical/` - Documentation for existing implemented features
- `_docs/high-level/` - Product vision and MVP specifications
