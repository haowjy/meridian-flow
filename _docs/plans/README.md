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

### [Tool Continuation](./tool-continuation.md)
**Status:** Ready to implement
**Priority:** High
**Effort:** 4-6 hours

Implement automatic tool execution continuation so LLMs can use tools and see results without frontend involvement. Critical for "don't lose conversation on browser close" goal.

**Current gap:** Tools execute but conversation stops before LLM sees results (TODO at `mstream_adapter.go:567`).

**Implementation:** Refactor `workFunc` for recursion, add continuation logic, load conversation history, and continue streaming until `stop_reason != "tool_use"`.

---

### [Chat Streaming Markdown Rendering](./chat-streaming-markdown-rendering.md)
**Status:** In planning
**Priority:** Medium
**Effort:** TBD

See existing plan document for details.

---

### [AI Editing MVP0](./ai-editing-mvp0.md)
**Status:** In progress
**Priority:** High
**Effort:** TBD

See existing plan document for details.

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
