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

## Invariants

These hold however the work is done, but they can change too. When evidence shows one
no longer serves writers, propose the change to the owner as its own step, never as a
side effect of getting a task to pass. How the code keeps each one, what checks it and
where it falls short: [.context/invariants.md](.context/invariants.md).

- **Text merges through Yjs.** Anything else that changes text does it as an ordinary
  edit every copy receives.
- **Writer text stays out of logs and diagnostics.**
- **Marks and receipts say truthfully who did what.**

Everything else is the current implementation, open to rewriting once evidence or
testing shows something better.

## Engineering

**Choose the simpler system, not the smaller change.** When a case doesn't fit, change the
design so it does, instead of adding a branch, flag or special case to the old one. Judge a
choice by the code left afterwards: a bigger change or more deletion that leaves less to
understand wins, and the next change should be easier than this one was.

**Fix structural debt in the same PR,** whatever the PR's size: refactor, delete dead
code and simplify without asking. A found fix too large for the PR gets its own PR now;
an issue is only for a fix that needs a product decision or is a project of its own.

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

**Diagrams stay current.** The [architecture map](.context/system-architecture/README.md)
draws the system, the code's boxes, the writer journeys and the broken dependency rules (a table); each state
machine is drawn in a `state-machines.md` beside its code, listed in
[the index](.context/state-machines/index.md). A change that adds, removes or moves something
the map names (a package, a domain, a feature directory, a boundary or a dependency direction),
changes a writer journey, or changes a machine's states or transitions updates its diagram in
the same commit. `pnpm check:architecture` catches a path that disappeared, not a picture that
went wrong: passing it is not the test. The map opens at the `map` URL `pnpm dev`
prints. The pages and `map.config.mjs` (everything Meridian-specific: the coverage globs, dependency
rules, nav) live in `.context/system-architecture/`; the viewer, the check and the dev server are the
reusable engine in [tools/architecture-map](tools/architecture-map/README.md), which names no project.

**One way to do one thing, so the app feels consistent.** The same situation behaves and
looks the same wherever the writer meets it: an action waiting on the server, a failure, an
Undo, a list, a picker. A state machine takes one of the shapes in the index's patterns, and a
screen uses the shared component where one exists. Before adding a state or a component, check
whether an existing one already covers the case; a second way to do the same thing is
structural debt, fixed by moving the cases onto one.

**Tooling.** `pnpm`, Biome and Nx, never npm. No raw colors outside
`packages/design-tokens`.

**Comments.** Few. Write one only for what the code can't show and a wrong edit
would break silently, at the line it guards. No file headers, no decision ids.

Debugging: [docs/debugging.md](docs/debugging.md).

## Dev environment

Start with `pnpm dev` and find URLs with `pnpm portless:list`. Dev uses Portless
HTTPS routes: never assume ports. Setup is in [DEVELOPMENT.md](DEVELOPMENT.md), tool
rules in [tools/dev/AGENTS.md](tools/dev/AGENTS.md). After installing, upgrading or
patching a package, run `pnpm dev:restart`: the dev server doesn't watch `node_modules`. A dev stack belongs to the
session that started it.

**Debug with `./mf`; verify in the browser.** Use `./mf` to reproduce and read
state. Every change a writer sees or relies on, server-only changes included, gets
a prober's `agent-browser` run of the final code before it reaches `main`, with
screenshots in its PR. A feature built as part PRs into a release branch gets that
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
in `.context/qa/` beside their code, indexed in [docs/qa](docs/qa/README.md). A test pinned to a redesignable
decision lists it under `Pins implementation decisions` in its header; change the
decision, change the test.

## Git

Documentation-only and comment-only changes need no PR: push them straight to `main`.

A human merges into `main` or `staging`, or a model the global grant covers. A feature built
in several pieces gets one integration branch: each finished piece bases on it and merges into
it, instead of PRs stacked on each other, and the piece's worktree, stack and processes go as
soon as it's in. One PR carries the integration branch into `main`.

Once a PR is complete and a reviewer (another model, or the owner) has approved it, whoever
may merge it merges it at once. Before the merge, CI is green, the regressions the change could cause are exercised on the real system (`/testing`), and the
PR body is reread against the final diff, with evidence from the commit being merged. Don't hold
a finished PR for the owner to try first: he uses the app, and what he finds wrong becomes a follow-up PR.

Open a draft PR as soon as a branch has its first commit, and update its body with each push,
so anyone can see the work's state from the PR. Mark it ready when it's complete.

Write a PR body for a reader who knows nothing about the area, from the
[template](.github/PULL_REQUEST_TEMPLATE.md), and check it with
`pnpm check:pr-body <body.md>`. Its `## Changelog` section is the changelog; never
edit `CHANGELOG.md`.

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
