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

<!-- List each concrete change as its own item; do not collapse the PR into one
     paragraph. Label a bug fix explicitly ("Bug fix: ...") so it doesn't blend
     into feature description. For a bug fix or changed behavior, give Before
     and After; keep Before brief or omit it when no meaningful prior state
     exists. For a new capability, describe After only. Show changed UI states
     with screenshots or GIFs next to the item they illustrate. -->

- **Bug fix: <what was broken>.** Before: ... After: ...
- **<capability or behavior change>.** After: ...

## Walkthrough / Reproduction

<!-- Step-by-step instructions that walk a reviewer through every change so
     they can see it for themselves. Give one ### subsection per Before / After
     item, in the same order. In each, say how to set up (main or this branch,
     how to start it, seed data), then numbered steps, then what to expect: what
     main does for a bug fix, and what this branch does. Prefer the running app
     or ./mf. When a change has no manual path, say so and give the exact test
     command plus the edit that makes it fail. Keep every command
     copy-pasteable. -->

### <Before / After item>

1. Setup: ...
2. ...
3. Expect: main ... This branch ...

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

<!-- Record what was tested and observed: probes and the workflows they covered,
     gates, and expected versus actual results. Step-by-step instructions belong
     in Walkthrough / Reproduction; don't repeat them here. For performance
     changes, report comparable numbers with metric, method,
     environment/workload, and baseline/result; omit benchmarks when
     performance is unaffected. -->

- Workflow/probe:
- Expected / observed:
- Performance (when relevant):

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
