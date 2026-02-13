# Implementation Plans

This directory contains detailed implementation plans for features currently in development or ready to be built.

## Organization

Each plan document includes:
- **Problem statement** - What we're solving and why
- **Current state** - What works, what's missing
- **Architecture context** - How it fits into existing systems
- **Implementation plan** - Phased approach with code examples
- **Testing strategy** - Test cases and verification steps
- **Success criteria** - How we know it's done

## Active Plans

- `fb-realtime-collab-editing.md` - Canonical main plan for operation-based collaboration + AI proposal model.
- `collab-ai/README.md` - Focused collaboration plan index and phase map.
- `collab-ai/spec/storage-model.md` - Canonical dual-stream schema and provenance invariants.
- `collab-ai/spec/api-events-contract.md` - Canonical WS/REST/event/error contracts.
- `collab-ai/spec/compaction-retention.md` - Canonical compaction/floor/retention/deletion-safety rules.
- `collab-ai/spec/refresh-read-model-framework.md` - Read-model refresh/coalescing framework.
- `collab-ai/phase/phase-1-oplog-transport.md` - WebSocket transport + authoritative applied-ops log.
- `collab-ai/phase/phase-2-history-and-undo.md` - Durable history/restore + persistent undo model.
- `collab-ai/phase/phase-3-ai-proposals-and-review.md` - Proposal lifecycle + writer review UX surfaces.
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

## Plan Template

When creating new plans, include:

```markdown
# Feature Name

**Status:** Ready to implement | In planning | Blocked
**Priority:** High | Medium | Low
**Estimated effort:** X hours/days

## Problem Statement
What problem are we solving? Why is it important?

## Current State
### What Works ✅
### What's Missing ❌

## Architecture Context
How does this fit into existing systems?

## Implementation Plan
### Phase 1: [Name] (X hours)
### Phase 2: [Name] (X hours)
### Phase 3: Testing (X hours)

## Dependencies
What services/APIs/libraries are needed?

## Testing
Test cases and verification steps

## Success Criteria
- [ ] Checkbox list of done criteria

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|

## Related Documentation
Links to relevant docs
```

## Related Directories

- `_docs/future/` - Future features not yet scheduled for implementation
- `_docs/technical/` - Documentation for existing implemented features
- `_docs/high-level/` - Product vision and MVP specifications
