---
detail: standard
audience: developer, architect
---
# Frontend Diff Model

## Overview

The frontend derives review hunks by comparing canonical text with an ephemeral projection.

| Element | Description |
|---|---|
| Source | `canonicalDoc.getText('content')` plus ephemeral `clone + apply(pending proposals)` |
| Diff | `diff(toPlainText(canonicalDoc), toPlainText(projectedDoc))` |
| Trigger | Canonical text change, `_review_status` map change, or active proposal-set change |
| Identity | Grouped hunk region with contributing proposal set |
| Filtering | Projection input only includes proposals with `status = 'pending'` |

## Derivation Pipeline

1. Clone canonical Y.Doc.
2. Apply each pending proposal's `yjs_update` to the clone while tracking the text regions touched by that proposal.
3. Diff canonical vs clone to produce raw hunks.
4. Group nearby or overlapping raw hunks into user-facing hunk regions.
5. Attach the contributing proposal set (and proposal `yjs_update` references) to each grouped hunk.
6. Run projection GC: any pending proposal whose update contributes no remaining diff is auto-marked `stale`.
7. Render grouped hunks in CM6.
8. Destroy projection.

## Grouped Hunk Identity

Each hunk represents one visible region that may include one or more proposals.

Properties:
- Stable enough for user action in the current derive cycle.
- Carries all contributing `proposalId` values and `yjs_update` payload references.
- Matches the writer mental model: review by region, not by proposal rows.

## Projection GC and Stale Proposals

During projection recompute:

- If applying a pending proposal yields no diff in any grouped hunk, that proposal is stale.
- Stale proposals are auto-resolved to `stale` and never rendered as hunks.
- Thread UI shows stale proposals as "No longer relevant".

## Hunk Actions

| User action | Canonical/map mutation | Next derive result |
|-------------|------------------------|--------------------|
| Accept hunk | Apply all hunk proposal updates + set each proposal status `accepted` in one transaction | Hunk disappears (canonical catches up) |
| Reject hunk | Set each hunk proposal status `rejected` in one transaction | Hunk disappears (pending set shrinks) |
| Edit hunk | Reject then type, or accept then modify (`ORIGIN_HUMAN`) | Hunk disappears or reshapes around new canonical text |
| Undo accept hunk | Revert full transaction | Entire hunk reappears as one undo step |
| Undo reject hunk | Revert full transaction | Entire hunk reappears as one undo step |

## CM6 Rendering

Hunk rendering remains decoration-based:

- Deletions: mark decorations on canonical ranges.
- Insertions: widget decorations for inserted text.
- Replacements: deletion mark + insertion widget.
- Action controls: Keep / Edit / Discard widgets bound to grouped hunk region data.

## Performance

| Workload | Expected cost |
|----------|---------------|
| Clone + apply updates | ~2ms |
| Diff (~2000 words) | ~3-10ms |
| Group + decorate | ~1-3ms |
| Total derive cycle | ~5-15ms |

No debounce is required at chapter scale.

## Cross-References

- [Architecture](architecture.md)
- [Dual-Version Yjs Model](dual-version-yjs-model.md)
- [Local-First Authority](local-first-authority.md)
- [Review Undo Design](review-undo-design.md)
- [Implementation Plan](plan.md)
