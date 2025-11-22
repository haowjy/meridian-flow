# Future Features & Ideas

This directory contains documentation for future features, enhancements, and ideas that are not currently scheduled for implementation.

## Organization

- **Root level** - Fully designed future features with clear implementation paths
- `ideas/` - Raw ideas, brainstorms, exploratory concepts
- `provider-implementations/` - Provider-specific features and integrations
- `optimizations.md` - Performance and efficiency improvements
- `published-content-access.md` - Public content sharing features

## Featured Future Features

### [Block-Level Branching](./block-level-branching.md)
**Status:** Well-defined, ready for implementation
**Effort:** 2-3 days
**Priority:** Medium

Enable users to branch conversations from any block in an assistant turn. Allows interrupting mid-thinking, mid-tool-use, or mid-response to explore alternative directions.

**Use cases:**
- "Stop using that tool, try a different approach"
- "Don't overthink this, just answer"
- Fork conversation to explore multiple paths

**Implementation:** Requires `branch_from_block_id` column, message building updates, and frontend UI.

---

## Related Directories

- `_docs/plans/` - Active implementation plans for features being built now
- `_docs/technical/` - Documentation for existing implemented features
- `_docs/high-level/` - Product vision and MVP specifications
