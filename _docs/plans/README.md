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

- `fb-wikilinks-and-internal-links.md` - Editor-only: wikilink tokens, CM6 pill rendering, `@` autocomplete, click-to-navigate, LLM prompt guidance.
- `fb-at-references.md` - Thread `@`-file insertion, reference blocks, `BlockTransformer` pipeline, `ReferenceTransformer`. Depends on wikilinks Phase 1.
- `fb-compaction.md` - Context window management: `is_compaction` turns, auto/user/LLM triggers, `conversation_search` tool, tool result summarization. Depends on at-references Phase 2.
- `fb-document-history-v1.md` - Per-document snapshots + thread "touched docs" review.
- `fb-event-driven-refresh-framework.md` - Event-driven refresh + 30s polling fallback.
- `fb-tree-ai-suggestions-banner-accept-all.md` - Tree banner listing AI suggestions + project-wide accept all.
- `agents/fb-artifact-templates-and-project-instances.md` - Templates copied into project-owned instances.
- `agents/archive/fb-project-skills-v1-and-artifact-foundations.md` - Archived project skills plan.
- `agents/fb-remove-document-slugs.md` - ✅ Complete: Documents now use exact path addressing (slug column removed).

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
