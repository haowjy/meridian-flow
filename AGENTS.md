# Meridian Flow — Agent Instructions

This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.

## Mission

**Writers should spend their time writing, not fighting their tools.** The
audience is fiction writers producing 100+ chapter web serials at 5,000–10,000+
words a day, who need Scrivener-scale power without its complexity.

**Trust the user and the LLM, and make changes easy to review.** Both change
documents, often at once, and their writes land: no approval gates, refusals or
"safety" friction. The user is protected by seeing what changed and being able to
take it back. In the app, teach a concept once, then show state, not standing
explanations. See [trust the LLM][trust-llm] and [trust the user][trust-user].

**The server never says no.** Anything that edits a project is a client: the writer's browser
tab, their other device, an AI agent running on the server. A client shows its edit at once and
sends it, and the server stores it as sent, with no refusal and no check against attacks. When
two edits clash, a fixed rule settles them, and every client runs the same rule, so every screen
agrees without asking: two documents given one name both keep it, and moving a deleted document
brings it back. Nobody resends anything, and an agent is never told to re-read and try again. A
design that needs a refusal is a design to replace. The server still checks who is signed in,
and runs everything that costs money.

## Engineering

**Choose the simpler system, not the smaller change.** When a case doesn't fit, change the
design so it does instead of adding a branch, flag or special case to the old one. Judge a
choice by the code it leaves: a bigger change, or more deletion, is the right one when less is
left to understand and the next change gets easier. Fix structural debt in the same PR,
whatever its size: refactor, delete dead code and simplify without asking. A found fix too
large for the PR gets its own PR now; an issue is only for a fix that needs a product decision
or is a project of its own.

**Fix the root cause.** Gather the problems a probe, a review or the owner finds, trace each to its
root cause, and fix the cause, not the symptom: no guard, retry or special case where the
problem showed up. When the cause is the design, redesign it so the case can't happen, even if
that means a different system. Several problems often share one cause; fix it once. A rare edge
case with no fix at its cause can be left as it is: don't patch it, and don't hold work for it.

**One way to do one thing, so the app feels consistent.** The same situation behaves and
looks the same wherever the writer meets it: an action the server hasn't answered yet, a
failure, an Undo, a list, a picker. A state machine takes one of the shapes under Patterns in
[the index](.context/state-machines/index.md), and a screen uses the shared component where one
exists. Before adding a state or a component, check whether an existing one already covers the
case. A second way to do the same thing is structural debt: fix it by moving every use onto
one.

**Optimistic UI.** The writer sees the result of their action at once, and failure
shows on the thing they did. **Navigate first:** every destination change goes to
the new screen immediately and does its work in the background. Where only the
server can assign the address, [apps/app](apps/app/AGENTS.md) says how to wait.

**Writer primitives.** A **Project** is a body of work. A **Work** is a task-scoped
editing context in it: it groups chats, owns shared drafts, and holds `scratch://`
context. See [Work][work].

**Layering.** Apps are thin shells over `packages/` and
`apps/server/server/domains/`. Domain logic depends on ports, never concrete
adapters. Use package public exports. Architecture:
[.context/CONTEXT.md](.context/CONTEXT.md).

**Shared runtime.** Code that other products use as well lives in the `meridian-runtime` repo
(`../meridian-runtime`). It is one package published to npm as `@meridian-flow/runtime` (pinned in the pnpm catalog), with a
subpath entry per part: the model gateway (`@meridian-flow/runtime/gateway`), then the MCP client. Flow
manages it from here. When Flow needs a change there, make it in that repo as its own PR, then move Flow
onto the new version. Nothing specific to Flow goes in it, such as the models Flow offers, their
prices, or the `FLOW_` variables: that stays in `apps/server/server/lib/gateway/`
([wiring](apps/server/server/lib/gateway/.context/CONTEXT.md)).

To try a gateway change here before it is published, follow [the package's AGENTS.md](https://github.com/haowjy/meridian-runtime/blob/main/AGENTS.md#trying-a-change-in-flow-before-it-is-published).

**Diagrams stay current.** The [architecture map](.context/system-architecture/README.md)
draws the system, the code, the writer journeys and the broken dependency rules; each state
machine is drawn in a `state-machines.md` beside its code, listed in
[the index](.context/state-machines/index.md). A change that adds, removes or moves something
the map names, changes a writer journey, or changes a machine's states or transitions updates
its diagram in the same commit. `pnpm check:architecture` catches a path that disappeared, not
a picture that went wrong. The map opens at the `map` URL `pnpm dev` prints.

**Tooling.** `pnpm`, Biome and Nx, never npm. No raw colors outside
`packages/design-tokens`.

**Comments.** Few. Write one only for what the code can't show and a wrong edit
would break silently, at the line it guards. No file headers, no decision ids.
`pnpm check` fails on a new or changed comment until `pnpm check:comments --update-baseline`
records it, and the reviewer questions that baseline line.

## Dev environment

Start with `pnpm dev` and find URLs with `pnpm dev:urls`. Each checkout's stack runs on
its own `localhost` ports, and a worktree's are set in its `.env.local`: never assume a port. Setup is in [DEVELOPMENT.md](DEVELOPMENT.md), tool
rules in [tools/dev/AGENTS.md](tools/dev/AGENTS.md). After installing, upgrading or
patching a package, run `pnpm dev:restart`: the dev server doesn't watch `node_modules`. A dev stack belongs to the
session that started it.

**Debug with `./mf`; verify in the browser.** Use `./mf` to reproduce and read
state; [docs/debugging.md](docs/debugging.md) has the rest. Every change a writer sees or relies on, server-only changes included, gets
a prober's `agent-browser` run of the final code before it reaches `main`, with a
video of the run and screenshots of its key states in its PR, uploaded with `gh pr edit --attach`, never committed. A feature built as part PRs into a release branch gets that
run once, on the whole feature after review, not one per part; each part's coder
checks its own screens in the browser. `./mf` output never stands in for it.

**Live model calls go to `deepseek-flash`,** or the mock provider when the model's
output doesn't matter. For a live run set `LIVE_TEST_MODEL=deepseek-flash`: every
model call goes there, whatever an Agent or chat names. Don't call other providers
to confirm a model exists. Model facts come from [models.dev](https://models.dev).

## Build and test

`pnpm check` is the full local gate; `pnpm test:db` and CI run the full DB suite. Test
budgets:
[tools/ci/README.md](tools/ci/README.md).

Keep no new test the user didn't ask for (`/testing`); propose one with the risk it guards.
A test you keep asserts what the code produces, not mocks or call counts. Prefer probes
in `.context/qa/` beside their code, indexed in [docs/qa](docs/qa/README.md). A `.context/` page that
records a redesignable decision may name the tests that pin it; change the decision, change
those tests.

## Git

Documentation-only and comment-only changes need no PR: push them straight to `main`.

Any model may merge into `main` or an integration branch without asking the owner, features and
big refactors included; what turns out broken is fixed by a new PR. A feature built
in several pieces gets one integration branch: each finished piece bases on it and merges into
it, instead of PRs stacked on each other, and the piece's worktree, stack and processes go as
soon as it's in. One PR carries the integration branch into `main`.

Once a PR is complete and a reviewer (another model, or the owner) has approved it, its author
merges it at once. Before the merge, `pnpm check` is green on the final commit, the prober's
browser run is done where "Debug with `./mf`" asks for one, the regressions the change could
cause are exercised on the real system (`/testing`), and the PR body is reread against the final
diff, with evidence from the commit being merged. Changes to the database, to prompt text that
DB tests pin, or to the boot path also run `pnpm test:db`, `pnpm test:probes` and the relevant
`pnpm smoke:*` command; `pnpm check` covers only the DB tests related to the change. The CI
workflow is manual: dispatch it for a release or when the full net is wanted. When a check is added, removed or renamed,
update this paragraph and the PR template's Verification section in the same change. Don't hold a
finished PR for the owner to try first: he uses the app, and what he finds wrong becomes a
follow-up PR.

Open a draft PR as soon as a branch has its first commit, and update its body with each push,
so anyone can see the work's state from the PR. Run `pnpm check` on the draft as you work and
again before marking it ready: PR and push events no longer start CI. Lefthook still checks
staged files on commit, and on push runs debug probes and the database package's tests.
Mark it ready when it's complete.

Write a PR body for a reader who knows nothing about the area, from the
[template](.github/PULL_REQUEST_TEMPLATE.md), and check it with
`pnpm check:pr-body <body.md>`. Its `## Changelog` section is the changelog; never
edit `CHANGELOG.md`.

Never run a bare `git stash` or `git stash pop`: every worktree shares one stash stack, so a pop can
take another agent's entry. Set work aside with a WIP commit on your own branch.

Never switch the branch of a checkout you do not own. Work in a sibling worktree:
`git worktree add ../meridian-flow.worktrees/<name> -b <branch> <base>`.

Clean up as soon as something has done its job, a worktree as soon as its branch
merges, even if a human's shell is still in it: [the
steps](tools/dev/AGENTS.md#cleaning-up). Before handing back, check that nothing you
started is still running.

Use full GitHub URLs for the [docs repository][meridian-flow-docs], relative links
in this repository.

[meridian-flow-docs]: https://github.com/haowjy/meridian-flow-docs
[trust-llm]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/trust-the-llm.md
[trust-user]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/copy-and-feedback.md
[work]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/work/index.md
