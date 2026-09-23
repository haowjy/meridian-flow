<!-- Describe the PR's final state, not its history. Give reviewers enough
     context to understand the change. -->

## Why

<!-- State the problem or opportunity and why it matters. For UI changes, show
     the current experience when useful. -->

## Goal

<!-- State what must be true after merge. -->

## Summary

<!-- Briefly map the solution and key tradeoffs; omit commit logs and diff stats. -->

## Diff

<!-- Report file/line totals excluding generated migrations, then give
     non-overlapping area totals that add up. Report migrations under DB Changes. -->

- Non-migration total: N files, +N / -N
- Breakdown:
  - Area: N files, +N / -N — what changed

## Before / After

<!-- For fixes or changed behavior, show Before and After; keep Before brief or
     omit it when no meaningful prior state exists. For new capabilities,
     describe After only. Show changed UI states with screenshots or GIFs. -->

- Before (when meaningful):
- After:

## Reproduction / Workflow

<!-- Give setup and numbered steps to reproduce the fix or exercise the changed
     workflow, with expected results. If it has no manual path, say why. -->

- Setup:
- Steps and expected results:

## Code Changes

<!-- Group production-code additions, refactors, and deletions by area; include
     key paths and rationale. Aim to lower net-new code over time by simplifying,
     refactoring, and removing duplication/dead paths—not by shrinking this diff.
     Explain substantial additions. Track temporary code or cleanup deferred for
     delivery speed/product clarity, with its reason and removal trigger. -->

- Added:
- Refactored:
- Deleted:

## DB Changes

<!-- Remove if no schema changes. Otherwise name migrations; diagram changed
     tables/relationships in Mermaid, mark added/dropped/renamed columns, and
     list new constraints/indexes. -->

## Work Item

<!-- Link the issue, work item, design, or plan; otherwise say this was direct
     maintenance. -->

## Testing

<!-- List tests added/refactored/deleted and the contract or risk each protects
     (or why removal is safe). Don't add tests for volume or coverage; consider
     deleting redundant tests and development scaffolding. -->

- Added:
- Refactored:
- Deleted:

## Verification

<!-- List commands and runtime checks run, with results. For performance work,
     include the metric, method, environment/workload, baseline, and result. No
     benchmark is needed when performance is not materially affected. -->

- [ ] `pnpm check`
- [ ] Runtime smoke / browser probe where behavior changed

## Deferred

<!-- List deferred work and its tracking home: issue for cross-cutting work;
     nearest .context/TODO or .context/FUTURE for local work. Temporary code or
     cleanup deferred for speed/product clarity needs a removal trigger. Say if none. -->

- [ ] Tracking home for each deferral; removal/cleanup trigger when applicable, or none

## Knowledge Updates

<!-- List durable guidance updated, or say why none was needed. -->

- [ ] `.context/` / KB updates are included, or not needed

## Spawn Trace

<!-- List delegated agents and roles, or say the work was done directly. -->
