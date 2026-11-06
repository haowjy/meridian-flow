# Meridian Flow — Agent Instructions

> **v3 full-stack rebuild.** TypeScript with Yjs + TipTap, Drizzle over Postgres,
> WorkOS AuthKit, and credits-only billing. There are no real users or data.
> Change schemas freely, delete unused code, and never add compatibility shims;
> write migrations as if production data exists (no data loss, online-safe DDL,
> and no skips that rely on empty tables).

## Mission

**Writers should spend their time writing, not fighting their tools.** Every
product and architecture choice should help a fiction writer bring an idea to
life faster, with AI that understands narrative craft.

**Audience:** fiction writers producing 100+ chapter xianxia, LitRPG, and
progression-fantasy web serials at 5,000–10,000+ words/day who need
Scrivener-scale power without its complexity.

**Trust the user and the LLM, and make changes easy to review.** The user and
the model both change documents, often at the same time, and changing a
document should be smooth for both. Their writes land: never put approval
gates, refusals, or "safety" friction in front of them. The user is protected
by seeing what changed and being able to take it back. AI writes merge like any Yjs peer's,
marks and receipts say who did what, and review makes conflicting changes easy
to resolve. In the app, teach each concept that needs words in one place, then
trust the user to know it: screens show state, not standing explanations. See the
[trust ruling](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/platform/stack/trust-the-llm-mission.md)
and [trust the user](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/trust-the-user.md).

## Engineering principles

**Fix structural debt in the same PR.** Do not defer parallel hierarchies,
leaking abstractions, shallow modules, split ownership, or obvious
simplification.

**Optimistic UI.** The writer sees the result of their action at once. The
network catches up. Failure belongs on the thing they did. Do not wait for
the server to change the screen. Do not show a successful screen while the
action is still pending.

**Navigate first.** Every destination change goes to the new screen
immediately. Create, persist, and connect in the background. This is the
default for every screen, not only chat. If the background work
fails, the error is on that destination. Never return to the previous screen
because the new one has not finished materializing. Where only the server can
assign the address, [apps/app](apps/app/AGENTS.md) says how to wait.

**Writer primitives:** a **Project** is a serial, book, or body of work. A
**Work** is a task-scoped editing context within a project: it groups chats,
owns shared drafts, carries a goal, and holds `scratch://` context. Addresses,
handles, No Work and rebinding are in the
[Work decisions](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/work/index.md).

## Agency

Act on confident inferences. Do not ask permission to refactor, delete dead
code, or simplify.

## Conventions

**Layering.** Apps are thin shells. Business logic lives in packages or server
domains, not route handlers. Use package public exports.

**Ports and adapters.** Domain logic depends on explicit ports, never concrete
adapters. Provider choice is config-driven DI at the composition root. Use
`domain/`, `ports/`, and `adapters/` where the seam earns it; new and growing
domains converge on that layout.

**Tooling.** Use `pnpm`, Biome, and Nx. Do not use npm. Do not add raw colors
outside `packages/design-tokens`.

**Comments.** File headers say what a file is for. Inline comments explain only
hidden constraints, surprising invariants, and workarounds.

**Writing.** Load and apply `/llm-writing` before writing or revising user-facing
text or documentation: UI copy, guides, README files, AGENTS.md, .context/, KB
pages, work artifacts, PR descriptions, and release notes. Apply
`/information-hierarchy` to multi-section documents: lead with what the reader
needs, then disclose depth.

**Debugging.** Follow [docs/debugging.md](docs/debugging.md).

## Knowledge and structure

This is a TypeScript monorepo. `apps/app`, `apps/server`, and `apps/www` are
shells over `packages/` and `apps/server/server/domains/`; dev and CI scripts
live in `tools/`. See [.context/CONTEXT.md](.context/CONTEXT.md) for the root
architecture.

Update the relevant `AGENTS.md`, `.context/`, or KB material when a change
shifts the mental model, contracts, or decisions.

**Keep principles apart from implementation.** Write something as a decision or
principle only when it is meant to hold. Describe everything else as the current
implementation, which can change when a better design turns up. The owner's
remarks are direction and suggestions unless they say otherwise: quote them, keep
their uncertainty, and don't record them as rulings. Measurements and incident
history go beside the code or tool they concern, not into rules.

## Dev environment

Dev uses Portless HTTPS routes. Never assume raw ports, bind ports manually, or
probe `ws://127.0.0.1:<port>`. Start with `pnpm dev`; discover URLs with
`pnpm portless:list`.

After installing, upgrading, or patching a package, run `pnpm dev:restart`: the
dev server doesn't watch `node_modules`.

Postgres is `postgres:16` plus pg_bigm (`tools/postgres/Dockerfile`; btree_gin and pg_trgm
are contrib); `DATABASE_URL` is the app seam. Use
noninteractive libpq authentication (`PGPASSWORD` or `-w`).

Dev stacks use more memory than the tests; when the host is short, run
`pnpm dev:stacks` first. A stack belongs to the session that started it: stop
only yours, or reap idle ones when asked.

Setup: [DEVELOPMENT.md](DEVELOPMENT.md). Dev tooling rules:
[tools/dev/AGENTS.md](tools/dev/AGENTS.md).

**Debug with `./mf` while working; verify in the browser at the end.** Use
`./mf` to reproduce, set up state, and read durable state and server logs
([docs/debugging.md](docs/debugging.md#set-up-and-debug-with-the-cli),
[`./mf` drives shared client cores][mf-shared-cores]). Verification is a prober's
browser run, with `agent-browser`, of what the writer sees. Every PR that changes
anything a writer sees or relies on ends with one, screenshots in the PR, server-only
changes included. `./mf` output never stands in for that run.

**Live model calls go to `deepseek-flash`.** These runs check Flow, not model
behavior: use the mock provider when the model's output doesn't matter, and
`deepseek-flash` when a run needs a real model. Don't call other providers to
confirm a model exists or works. Model facts (limits, prices, modalities) come
from [models.dev](https://models.dev); read a provider's API docs only for what
models.dev lacks.

## Build and test

`pnpm check` is the full local gate. Its final DB step uses Vitest's module
graph to run the DB test files related to changes since `origin/main`, including
uncommitted and untracked files. DB test infrastructure, dependency resolution
and migrations force the full DB suite; `DB_GATE_FULL=1 pnpm check:db` does the
same. `pnpm test:db` and CI's `db-tests` job always run the full DB suite.
`pnpm test:all` runs unit and managed DB tests together.

The test case count per file may not grow against
`tools/ci/test-case-baseline.json`, and the suite has a memory ceiling. Refresh
the baseline deliberately with `TEST_BUDGET_UPDATE=1 pnpm test` when growth is
intended. Never raise a worker count without measuring memory. Details:
[tools/ci/README.md](tools/ci/README.md#test-budget-ratchet).

Write few unit tests. A new test must protect a named risk that no KB decision
and no probe already covers. A test that only restates a recorded decision, or
a step a browser recipe already drives, covers no code: delete it in the change
that supersedes that decision, and prune a weaker duplicate rather than add
another layer. To verify a change, prefer probes,
end-to-end smoke scripts and written manual-testing steps in the
[runtime probe catalog](docs/qa/README.md); add or update the recipe that
covers what you changed.

Assert what a decision produces (state, rows, events, text), not mocks, call
counts or internal shapes, unless the internal detail is itself the decision.
A test file that guards an implementation decision that could be redesigned
lists it in its header under `Pins implementation decisions (rewrite or delete
these cases when one changes):`. When you change such a decision, find its tests
with `git grep` and rewrite or delete them in the same change.

## Git workflow

Commit often, one self-contained change at a time.

The PR body's `## Changelog` section holds the changelog entry; never edit `CHANGELOG.md`.

A human merges product changes into `main` or `staging` unless explicitly
instructing the agent to merge. Merges between working branches need no gate.
Documentation-only changes commit directly to `main`; never open a PR only for
documentation. This includes `AGENTS.md`, `.context/`, KB, and the Meridian Flow
docs repository.

Write a PR body for a reader who knows nothing about the area. Explain each term
in a few words the first time it appears, and link the issues, PRs, decisions and
code it refers to, so a newcomer catches up quickly. The
[PR template](.github/PULL_REQUEST_TEMPLATE.md) holds the sections. Check a draft with
`pnpm check:pr-body <body.md>` before `gh pr create`; `pnpm check` checks the branch's open PR body.

**Clean up as soon as you're done with something.** Idle dev stacks, databases and
checkouts waste the machine's memory, CPU and disk. When a worktree, dev stack, probe,
review checkout or temporary branch has done its job (a worktree as soon as its
branch merges, into `main`, `staging`, or an integration branch), clean it up, even
while a human's shell or browser is still in it:

1. Stop its dev stack with `pnpm dev --stop`.
2. End anything still running from it (the Nx daemon, `agent-browser` sessions, watchers).
3. Remove the worktree, its database and its merged branch with
   `pnpm dev:prune-worktrees -- --target <branch|path>` (`--dry-run` first; see
   [tools/dev/AGENTS.md](tools/dev/AGENTS.md)).
4. For a detached checkout the tool refuses, run `pnpm dev --stop` in it, then
   `git worktree remove` it, and drop its database with `pnpm dev:gc-dbs`.
5. On `main` after the merge completes, remove the merged PR's screenshot
   directory with `git rm -r .github/pr-assets/<dir>`, then commit. PR bodies
   link each image at a commit, and that commit keeps it readable after the
   files leave the tree.

Run `pnpm dev:gc-dbs` after a batch of cleanups to drop databases that no worktree owns.
Before you hand control back, check that nothing you started is still running.

Never switch the branch of a checkout you do not own. From the primary
checkout, create another branch under the sibling worktree root, then pass its
path to spawns with `--task-dir`:

```bash
git worktree add ../meridian-flow.worktrees/<name> -b <branch> <base>
```

## Links

- Use full GitHub URLs for the [Meridian Flow docs repository][meridian-flow-docs].
- Use relative links within this repository.
- Prefer reference-style links.

[meridian-flow-docs]: https://github.com/haowjy/meridian-flow-docs
[mf-shared-cores]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/dev-cli/mf-drives-shared-client-cores.md
