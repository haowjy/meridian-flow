<!-- Describe the PR's final state, not its history. Give reviewers enough
     context to understand the change.

     Every ## section below is required, and the PR-body check fails when one
     is missing. When a section doesn't apply, keep its heading and write
     "None." with a short reason. Use ### for your own subheadings inside a
     section; the check reads only ## headings. -->

## Why

<!-- State the problem or opportunity and why it matters. For UI changes, show
     the current experience when useful. -->

## Core design decisions

<!-- Name the core design decisions behind the change: the underlying
     problems, not just their symptoms. For each, say what was wrong, what this
     PR decides, and what it rules out. Quote the owner's rulings where they
     set a decision. -->

1. **<decision>.** <the problem>. <what this PR decides>. Ruled out: <alternative and why>.

## Goal

<!-- Start with the long-term goal this PR serves: the product direction it
     moves toward, even when this PR is one step of it. Then state what must
     be true after merge. Then list related work: PRs this builds on or
     unblocks, issues it fixes or prepares for, follow-ups, and the work item. -->

**Long term.** <the direction this PR moves toward>

**This PR.**

- <what must be true after merge>

**Related work.**

- #N: <how it relates>

## Summary

<!-- Briefly map the solution and key tradeoffs; omit commit logs and diff stats. -->

## Diff

<!-- Report file/line totals excluding generated migrations, then give
     non-overlapping area totals that add up. Report migrations under DB Changes. -->

- Non-migration total: N files, +N / -N
- Breakdown:
  - Area: N files, +N / -N — what changed

## Before / After

<!-- List each concrete change as its own item; don't collapse the PR into one
     block of text. Label a bug fix explicitly ("Bug fix: ...") so it doesn't blend
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

## How the code changed

<!-- Explain briefly how the code works now and what changed in its structure:
     which models, boundaries, data flow or ownership moved, and why this shape.
     A reader who hasn't opened the diff should come away understanding how it
     works. Use short bullets or sentences, one idea each. Keep it short: no
     file-by-file lists, and name a file only where it helps the explanation.
     Say what was deleted or simplified. Track temporary code with its removal
     trigger. -->

## DB Changes

<!-- Write "None." when the PR changes no schema. Otherwise name migrations;
     diagram changed
     tables/relationships in Mermaid, mark added/dropped/renamed columns, and
     list new constraints/indexes. -->

## Work Item

<!-- Link the work item, design, or plan; otherwise say this was direct
     maintenance. Related PRs and issues go under Goal. -->

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

## Follow-ups

<!-- What to do right after this merges, in order: the next PR in a sequence,
     stacked or sibling branches that must take main, issues to start, probes to
     rerun on main. Link each issue or PR. Deferred is scope this PR leaves out;
     Follow-ups is what someone does next. Skip routine cleanup that AGENTS.md
     already requires. Write "None." when nothing follows. -->

- [ ] #N: <what to do right after merge>

## Knowledge Updates

<!-- List durable guidance updated, or say why none was needed. -->

- [ ] `.context/` / KB updates are included, or not needed

## Spawn Trace

<!-- List delegated agents and roles, or say the work was done directly. -->
