<!-- Give reviewers enough context and evidence to decide whether this change
     should merge without reconstructing the work from code, chat history, or a
     local checkout. Describe the final state of the PR, not its chronology. -->

## Why

<!-- Give the reason for the change: the current problem, opportunity, or
     constraint; evidence that it exists; and why it matters now. This is the
     motivation, not the solution. For user-facing UI changes, include a
     screenshot or GIF of the current experience when it makes the problem
     concrete. -->

## Goal

<!-- Define the outcome this PR is accountable for. The goal is its acceptance
     boundary: what must be true after merge, not a list of tasks, files, or
     implementation steps. -->

## Summary

<!-- Orient the reviewer to the diff. List the major implementation or design
     changes, important boundaries, and deliberate tradeoffs. This should be a
     map of the solution, not a commit log or a repeat of Resulting Behavior. -->

## Resulting Behavior

<!-- Show the goal realized in concrete, observable terms: workflows, outputs,
     failure behavior, and anything important that remains unchanged. For
     user-facing UI changes, place screenshots beside the states they demonstrate
     and use GIFs when interaction or motion carries meaning. Show every changed
     surface and meaningful state (empty, filled, error, narrow). The human merge
     gate is visual — no visual evidence, no review. -->

## Work Item

<!-- Point the reviewer to the source of scope and decisions by linking the
     relevant issue, work directory, design, or plan. This makes alignment
     inspectable. If this was direct maintenance with no tracked artifact, say
     so. -->

## Verification

<!-- Prove the claims in Resulting Behavior. Record the exact automated gates,
     focused tests, and runtime journeys run against the final commit, along with
     their results or evidence links. Check only what ran; explain anything not
     applicable or blocked. -->

- [ ] `pnpm check`
- [ ] Runtime smoke / browser probe where behavior changed

## Knowledge Updates

<!-- Show that future contributors will learn the new mental model. List the
     durable guidance updated with this change, such as `CHANGELOG.md`,
     `AGENTS.md`, `.context/`, or the KB. If none was needed, explain why the
     existing guidance remains accurate. -->

- [ ] `.context/` / KB updates are included, or not needed

## Spawn Trace

<!-- Make delegated work inspectable. List agent or spawn IDs and each role, such
     as implementation, review, runtime probe, or knowledge reconciliation. If
     the work was completed directly, say so. -->
