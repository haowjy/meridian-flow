# Meridian Flow — Agent Instructions

> **v3 full-stack rebuild.** TypeScript with Yjs + TipTap, Drizzle over Postgres,
> WorkOS AuthKit, and credits-only billing. There are no real users or data yet:
> change schemas freely, delete unused code, add no compatibility shims.

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

These hold however the work is done. Each changes only as its own visible step,
never to get a task passing:

- Migrations lose no data: online-safe DDL, and no skip that relies on empty
  tables ([`migration-lint`](tools/dev/migration-lint.ts)).
- Every copy of a document's text converges, and no accepted edit is lost in the
  merge. [`text-convergence.test.ts`](apps/server/server/domains/collab/text-convergence.test.ts)
  checks this through the production room, persistence, and stored-state path.
- Writer text stays out of logs and diagnostics. The sanitizers are checked
  (`packages/yjs-inspect`'s canary, `safe-event.test.ts`); what emit sites pass them
  is not.
- Marks and receipts say truthfully who did what. Checked for live and draft
  writes, response rollback, subagent bylines, model and writer inverse receipts,
  Apply settlement, and tree receipts. Browser display is not checked.

Everything else is the current implementation, open to rewriting once evidence or
testing shows something better. The owner's words are direction, not rulings:
reason against them when the evidence says to. Write down the behavior and its
reason, not who said it. Never paste the owner's messages into docs, briefs, issues,
commits or PRs: he refines a point over several messages, so one message out of its
conversation misleads. Write each decision for a reader who never saw that
conversation: what was decided, what it applies to, his reason if he gave one, and
whether it is settled or only an idea.

## Engineering

**Act on confident inferences.** Refactor, delete dead code and simplify without
asking. Fix structural debt in the same PR, whatever the PR's size.

**Fix what you find as you work,** including problems that were already there. A small
fix goes in the current PR, and a larger one gets its own PR now. Call out every found
fix in the PR body, so a reader can tell it apart from the change the PR is for. File an
issue only when the fix needs a product decision or is a project of its own.

**Optimistic UI.** The writer sees the result of their action at once, and failure
shows on the thing they did. **Navigate first:** every destination change goes to
the new screen immediately and does its work in the background. Where only the
server can assign the address, [apps/app](apps/app/AGENTS.md) says how to wait.

**Writer primitives.** A **Project** is a body of work. A **Work** is a task-scoped
editing context in it: it groups chats, owns shared drafts, and holds `scratch://`
context. See the [Work decisions][work-decisions].

**Layering.** Apps are thin shells over `packages/` and
`apps/server/server/domains/`. Domain logic depends on ports, never concrete
adapters. Use package public exports. Architecture:
[.context/CONTEXT.md](.context/CONTEXT.md).

**Tooling.** `pnpm`, Biome and Nx, never npm. No raw colors outside
`packages/design-tokens`.

**Comments.** Few. Write one only for what the code can't show and a wrong edit
would break silently, at the line it guards. No file headers, no decision ids.

**Writing.** Load `/llm-writing` before writing anything a person or agent will read
later. Update `AGENTS.md`, `.context/` or the KB when a change makes them wrong.
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

Write few unit tests. A new test protects a named risk that no probe or other test
already exercises, and asserts what the code produces, not mocks or call counts. Prefer probes
in `.context/qa/` beside their code, indexed in [docs/qa](docs/qa/README.md). A test pinned to a redesignable
decision lists it under `Pins implementation decisions` in its header; change the
decision, change the test.

## Git

Commit often. Worktrees, commits, pushes, PRs and issues need no permission.
Documentation-only and comment-only changes need no PR: push them straight to `main`.
A wrong comment or doc gets fixed as soon as you see it, without asking.

A human merges into `main` or `staging`; `CLAUDE.md` grants Claude Opus more. A feature built
in several pieces gets one integration branch: each finished piece bases on it and merges into
it, instead of PRs stacked on each other, and the piece's worktree, stack and processes go as
soon as it's in. One PR carries the integration branch into `main`.

A PR merges as soon as it is complete and a reviewer has approved it: another model, or the
owner. Before the merge, CI is green, the regressions the change could cause are tested, and the
PR body is reread against the final diff, with evidence from the commit being merged. Don't hold
a finished PR for the owner: he uses the app, and what he finds wrong becomes a follow-up PR.

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
[trust-llm]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/platform/stack/trust-the-llm-mission.md
[trust-user]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/trust-the-user.md
[work-decisions]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/work/index.md
