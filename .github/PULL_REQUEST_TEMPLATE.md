<!-- Give reviewers enough context to understand and verify the final change. -->

## Why

<!-- State the problem or opportunity and why it matters. For UI changes, show
     the current experience when useful. -->

## Goal

<!-- State what must be true after merge. -->

## Summary

<!-- Briefly map the solution and key tradeoffs; omit commit logs and diff stats. -->

## Before / After

<!-- For fixes or changed behavior, show Before and After. For new capabilities,
     describe After only. Include important workflows and failures. For UI
     changes, show each changed surface/state; screenshots or GIFs are required.
     Compare material performance changes under the same workload. If runtime
     behavior is unchanged, say so. -->

- Before (for fixes/existing behavior changes):
- After:

## Code Changes

<!-- List production-code changes by area, with key paths and rationale. Favor
     lower net-new code over time: simplify, refactor, and delete duplication or
     dead paths. Larger diffs are fine when they leave code simpler. Justify
     substantial additions. Track temporary code/deferred cleanup with a reason
     and removal trigger. -->

- Added:
- Refactored:
- Deleted:

## Diff

<!-- Report file/line totals excluding generated migrations, then give
     non-overlapping area totals that add up. Report migrations under DB Changes. -->

- Non-migration total: N files, +N / -N
- Breakdown:
  - Area: N files, +N / -N — what changed

## DB Changes

<!-- Remove if no schema changes. Otherwise name migrations; diagram changed
     tables/relationships in Mermaid, mark added/dropped/renamed columns, and
     list new constraints/indexes. -->

## Work Item

<!-- Link the issue, work item, design, or plan; otherwise say this was direct
     maintenance. -->

## Testing

<!-- List tests added/refactored/deleted and the risk they cover or why removal
     is safe. Don't add tests to inflate count or coverage; consider deleting
     redundant tests and scaffolding. -->

- Added:
- Refactored:
- Deleted:

## Verification

<!-- List commands and runtime checks run, with results. For performance claims,
     include method, workload, baseline, and result; benchmark only when material. -->

- [ ] `pnpm check`
- [ ] Runtime smoke / browser probe where behavior changed

## Deferred

<!-- List deferred work and its tracking home: issue for cross-cutting work;
     nearest .context/TODO or .context/FUTURE for local work. Temporary code or
     cleanup deferred for speed/product clarity needs a removal trigger. Say if none. -->

- [ ] Tracking home for each deferral; cleanup triggers where needed, or none

## Knowledge Updates

<!-- List durable guidance updated, or say why none was needed. -->

- [ ] `.context/` / KB updates are included, or not needed

## Spawn Trace

<!-- List delegated agents and roles, or say the work was done directly. -->
