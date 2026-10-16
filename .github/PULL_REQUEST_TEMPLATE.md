<!-- Write for a reader who knows nothing about this area: not the project's
     history, not the names of its parts, not the earlier PRs. Explain each
     term in a few words the first time it appears, and link what you refer
     to (issues, PRs, KB decisions, code, screenshots) instead of assuming the
     reader remembers it.

     Open each section with its point. Say each thing once, in the section
     that owns it, and cut any sentence the reader doesn't need. Describe the
     PR's final state, not how it got there.

     Every ## section is required, and the PR-body check fails when one is
     missing. When a section doesn't apply, keep the heading and write "None."
     with the reason. Add ### subheadings freely; the check reads only ##. -->

## Summary

<!-- What this PR does, in two to four bullets a reader could stop after.
     Name each change in the terms of whoever feels it (what a writer sees,
     what a developer can now do), not in terms of the code. -->

## Why

<!-- The problem or opportunity, and who it hurts or helps. For a UI change,
     show the current screen. -->

## Core design decisions

<!-- The decisions that shaped the change, each aimed at an underlying problem
     rather than its symptom. For each: what was wrong, what this PR decides,
     and what it rules out. Quote the owner where a ruling set the decision. -->

1. **<decision>.** <the problem>. <what this PR decides>. Ruled out: <alternative and why>.

## Goal

<!-- Open with the long-term direction this PR moves toward, even when it is
     one step of it. Then the conditions a reviewer can check after merge.
     Then the PRs this builds on or unblocks and the issues it fixes or
     prepares for. -->

**Long term.** <the direction this PR moves toward>

**This PR.**

- <what must be true after merge>

**Related work.**

- #N: <how it relates>

## Before / After

<!-- One item per behavior change, never one block of text. Start a bug
     fix with "Bug fix:". A fix or changed behavior gets Before and After,
     with Before kept short; a new capability gets After only. Put each
     screenshot or GIF next to the item it shows. When UI files changed but
     nothing looks different, write "No visual change" and say why. -->

- **Bug fix: <what was broken>.** Before: ... After: ...
- **<capability or behavior change>.** After: ...

## Walkthrough / Reproduction

<!-- Steps that let a reviewer see each change for themselves: one ###
     subsection per Before / After item, in the same order. Each gives setup
     (main or this branch, how to start it, seed data), numbered steps, and
     what to expect on main and on this branch. Drive the running app; use
     ./mf only to set up state. When a change has no manual path, say so and
     give the test command plus the edit that makes it fail. Make every command
     copy-pasteable. -->

### <Before / After item>

1. Setup: ...
2. ...
3. Expect: main ... This branch ...

## How the code changed

<!-- How the code's structure changed, not which lines changed: which module
     owns which decision now, what concept, boundary or seam is new, how data
     and control flow through it, and what was merged or deleted. Give the
     shape before and after. A reader who hasn't opened the diff should be
     able to sketch the new structure. Short bullets, one idea each. Don't
     list edits ("added a prop", "added a check") or files; name a module or
     symbol only where it anchors the structure. -->

- **<structural change>.** Before: <who owned what>. Now: <who owns it>.

## Diff

<!-- File and line totals without generated migrations, then area totals
     that don't overlap and add up. Name each area in a few words; How the
     code changed explains it. Migrations go under DB Changes. -->

- Non-migration total: N files, +N / -N
- Breakdown:
  - <area>: N files, +N / -N

## DB Changes

<!-- Name each migration. Diagram the changed tables and relationships in
     Mermaid, mark added, dropped and renamed columns, and list new
     constraints and indexes. -->

## Testing

<!-- Each test added, changed or deleted, with the risk it protects or why
     deleting it is safe. A new test protects a named risk that no KB decision
     or probe already covers (AGENTS.md, Build and test). -->

- Added:
- Refactored:
- Deleted:

## Verification

<!-- What you ran and what you saw: each probe and the workflow it drove,
     the gates, and expected against observed. Verification is a browser
     run driven by a prober (agent-browser), with screenshots, for every change
     a writer's experience runs through, server-only included. ./mf output is
     debugging context, not verification. A PR with no writer-reachable change
     says "Browser: none" with the reason. Steps belong in Walkthrough. For a performance
     change, give comparable numbers: metric, method, environment and
     workload, baseline and result. -->

- Workflow/probe:
- Expected / observed:
- Performance (when relevant):

## Deferred

<!-- Scope this PR leaves out, each with its tracking home: an issue for
     cross-cutting work, the nearest .context/TODO or .context/FUTURE for
     local work. Temporary code this PR ships names the trigger that removes
     it. Structural debt isn't deferred; AGENTS.md says to fix it in the same
     PR. -->

- [ ] <deferred work>: <tracking home>; <removal trigger, if temporary>

## Follow-ups

<!-- What someone does right after this merges, in order: the next PR in a
     sequence, stacked or sibling branches that must take main, issues to
     start, probes to rerun on main. Link each one. Skip routine cleanup that
     AGENTS.md already requires. -->

- [ ] #N: <what to do right after merge>

## Knowledge Updates

<!-- The AGENTS.md, .context/ or KB pages this PR updates, linked, or why
     none needed it. -->

- [ ] <page>: <what it now says>

## Work Item

<!-- Link the work item, design or plan, or say this was direct maintenance. -->

## Spawn Trace

<!-- The agents this work was delegated to and their roles, or "done
     directly". -->
