<!-- Describe the PR's final state, not how it got there. A reader should learn,
     in this order: what changes for writers, why, what it looks like in use,
     what it costs and risks, and how we know it works.

     Write for a reader who knows nothing about this area. Explain each term in
     a few words the first time it appears, and link what you refer to
     (issues, PRs, KB decisions, code, screenshots) instead of assuming the
     reader remembers it. Say each thing once, in the section that owns it.

     Every ## section is required, and the PR-body check fails when one is
     missing. When a section doesn't apply, keep the heading and write "None."
     with the reason. Add ### subheadings freely; the check reads only ##. -->

## Changelog

<!-- One line per change a writer or developer will notice, in the terms of
     whoever feels it. Start each line with Added:, Changed:, Fixed: or
     Removed:, at most 300 characters. A refactor, test, documentation or
     tooling change nobody can notice says "None." and why. `pnpm changelog`
     builds the changelog from these lines; never edit CHANGELOG.md. -->

- Fixed: <what a writer sees now that was broken before>

## Why

<!-- The problem or opportunity and who it hurts or helps, with before-state
     evidence when it exists: a screenshot of the current screen, failing
     output, timings, a reproduction. Then what must be true after merge, and
     the long-term direction when this PR is one step of it. Link the issues it
     fixes ("Fixes #N"). -->

## Examples

<!-- Walk through each behavior change as a writer meets it, one ### block per
     change, in Changelog order. Each block gives:
     - Setup: main or this branch, how to start it (`pnpm dev`, provider), seed data.
     - Steps: numbered, driving the running app. Use ./mf only to set up state.
     - Screenshots or a GIF beside the steps: Before and After for a fix or a
       changed behavior, After only for a new capability. Commit them under
       .github/pr-assets/<dir>/ and link them at a commit SHA so they stay
       readable after the files leave the tree.
     - Expect: what main does and what this branch does.
     A server-only change still shows the writer flow it runs through, with
     screenshots, plus its CLI or API output where that shows the change. When
     UI files changed but nothing looks different, write "No visual change"
     and say why, and still show the flow. When a change has no manual path,
     say so and give the test command plus the edit that makes it fail. -->

### <behavior change>

1. Setup: ...
2. ...
3. Expect: main ... This branch ...

## Benchmarks

<!-- Every writer-facing path whose speed this PR could change: opening a
     project or chat, a turn, a tool call, document load or save, a route.
     State the machine, workload, commits and method (runs, warm or cold,
     statistic) once above the table, and give a range when runs vary. A count
     of round trips or queries read from the code is not a timing; label it as
     such. Write "None." with why performance is unaffected when nothing on
     such a path changed. -->

<machine · workload · method>

| Path | Before | After | Change |
|---|---:|---:|---:|
| <path> | <N> ms | <N> ms | <±N%> |

## Design decisions

<!-- The decisions that shaped the change, each aimed at an underlying problem
     rather than its symptom. For each: what was wrong, what this PR decides,
     and what it rules out. Quote the owner where a ruling set the decision.
     Write "None." when the change involves no design choice. -->

1. **<decision>.** <the problem>. <what this PR decides>. Ruled out: <alternative and why>.

## Changes

<!-- Every part of the PR: each change a reviewer could ask "why is this here?"
     about, including fixes found along the way and anything added during
     review. A change missing from this table should not be in the diff.
     Line counts come from `git diff --numstat origin/main...HEAD`, excluding
     generated migrations, lockfiles and screenshots; parts sharing a file are
     approximate, the total is exact. Below the table, explain how a part
     works only where the diff alone would not make it clear: which module now
     owns which decision, what seam is new, what was merged or deleted. -->

| # | Part | Why it's here | Key paths | Source | Tests | Docs |
|---|---|---|---|---|---|---|
| 1 | <part> | <reason> | `<path>` | +N / -N | +N / -N | +N / -N |
| | **Total (N files)** | | | **+N / -N** | **+N / -N** | **+N / -N** |

## Compatibility and risk

<!-- What changes for existing writers and data, and where a reviewer's time
     pays off most. Write "None." with the reason for an item that doesn't
     apply.
     - Migrations and state: name each migration and how it stays online-safe
       with no data loss. Diagram changed tables and relationships in Mermaid,
       marking added, dropped and renamed columns, constraints and indexes.
       Say how existing rows, Yjs documents and stored state upgrade.
     - Clients during a deploy: what an already-open web app, or a stale
       cached build, does against the new server.
     - Rollback: what reverting this PR leaves behind.
     - Where to look: the two or three riskiest files or behaviors. -->

- Breaking or changed for writers:
- Migrations and state:
- Clients during a deploy:
- Rollback:
- Where to look:

## Verification

<!-- What you ran and what you saw, expected against observed.
     - Browser: every change a writer's experience runs through, server-only
       included, ends with a prober's agent-browser run whose screenshots are in
       Examples. ./mf output is debugging context, not verification. A PR with
       no writer-reachable change says "Browser: none" with the reason.
     - Model: name the provider each run used and why. A change to the
       harness (the agent stack in .context/CONTEXT.md, Harness composition:
       the runtime loop, gateway and tools, threads, context, collab and the
       rest) is recommended a real-model run (`deepseek-flash`) as well as the
       mock runs that pin its behavior. A change outside the harness can rely
       on the mock provider.
     - Tests: each test added, changed or deleted, with the risk it protects or
       why deleting it is safe (AGENTS.md, Build and test).
     - Not exercised: what you didn't run, and why.
     - Gates: the commands, in one line. -->

- Browser:
- Model:
- Tests:
- Not exercised:
- Gates:

## Deferred

<!-- Scope this PR leaves out, each with its tracking home: an issue for
     cross-cutting work, the nearest .context/TODO or .context/FUTURE for
     local work. Temporary code this PR ships names the trigger that removes
     it. Structural debt isn't deferred; AGENTS.md says to fix it in the same
     PR. Write "None." if nothing is. -->

- [ ] <deferred work>: <tracking home>

## References

<!-- The work item, design or plan this PR delivers (or "Direct maintenance."),
     related PRs and issues and how they relate, the AGENTS.md, .context/ or KB
     pages it updated (or why none needed it), what someone does right after
     merge, and every spawn whose work it carries. In the spawn trace, name
     the agent profile and the model it actually ran on, so a reader can tell
     which agents reviewed and verified the change. -->

- Work item:
- Related:
- Docs updated:
- After merge:

| Spawn | Agent | Model | Role |
|---|---|---|---|
| <id> | <agent> | <model> | <what it did, and what it reviewed or verified> |
