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

None currently.

## Implemented Plans

### Streaming Cancel: Race Condition Fix + Partial Thinking Persistence
**Implemented:** 2026-01-11

Consolidated two related plans into one implementation:
1. **Backend-Controlled Shutdown**: Frontend waits for SSE terminal event before refreshing
2. **Partial Thinking Persistence**: `persistPartialBlocks()` now saves both `text` and `thinking` blocks

Key files modified:
- `backend/internal/service/llm/streaming/mstream_adapter.go` - `canPersistPartialBlock()`, `persistPartialBlocks()`
- `frontend/src/core/stores/useThreadStore.ts` - `waitForStreamEnd()`, `notifyStreamEnded()`
- `frontend/src/features/threads/hooks/useThreadSSE.ts` - terminal event notifications

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
