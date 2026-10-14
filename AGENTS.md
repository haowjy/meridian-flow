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

**Trust the LLM.** AI writes merge like any Yjs peer's: marks and receipts
inform, and undo recovers. Never add approval gates, refusal vetoes, or
"safety" friction to AI writes; that gates the writer's instruction. See the
[trust ruling](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/platform/stack/trust-the-llm-mission.md).

## Engineering principles

**Fix structural debt in the same PR.** Do not defer parallel hierarchies,
leaking abstractions, shallow modules, split ownership, or obvious
simplification.

**Optimistic UI.** The writer sees the result of their action at once. The
network catches up. Failure belongs on the thing they did. Do not wait for
the server to change the screen. Do not show a successful screen while the
action is still pending. Do not invent recovery copy for a lost first send —
do not lose it.

**Navigate first.** Every destination change goes to the new screen
immediately. Create, persist, and connect in the background. This is the
default for the whole app, not a chat special case. If the background work
fails, the error is on that destination. Never return to the previous screen
because the new one has not finished materializing.

**Writer primitives:** a **Project** is a serial, book, or body of work. A
**Work** is a task-scoped editing context within a project; it groups threads,
owns shared drafts, carries a goal, and holds qualified `scratch://` context.
Every project has one locked **No Work** row. Omitting a Work or sending
explicit null binds the thread to that row. After creation, the writer may
explicitly rebind the chat through one canonical operation; Work management
and navigation never invoke it implicitly. The model can't rebind; see the
[model's `work switch`][model-work-switch]. Named-Work URIs use `@slug`;
No Work Uploads use `@/`. No Work owns no Scratch: a No Work chat's Scratch
belongs to its lineage (the first chat, its forks and subagents) at
`scratch://@/c12/`, named by the first chat's handle. Internal IDs never
appear in URI authority. The schema is `works` + `thread_works`.

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

**Writer-facing copy.** Separate facts with layout, typography, sentences, or
parentheses, never `·`, `•`, `—`, or `|`. See the
[copy separation decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/writer-copy-separation.md).

**Debugging.** Follow [docs/debugging.md](docs/debugging.md).

## Knowledge and structure

This is a TypeScript monorepo. `apps/app`, `apps/server`, and `apps/www` are
shells over `packages/` and `apps/server/server/domains/`; dev and CI scripts
live in `tools/`. See [.context/CONTEXT.md](.context/CONTEXT.md) for the root
architecture.

Update the relevant `AGENTS.md`, `.context/`, or KB material when a change
shifts the mental model, contracts, or decisions.

## Command output

Use `rtk` for noisy human-readable commands: `rtk git diff`, `rtk git status`,
`rtk rg "<pattern>"`, and `rtk pnpm test`. Use raw commands for exact or
machine-readable output. If `rtk` is unavailable, run the raw command and say
so.

## Dev environment

Dev uses Portless HTTPS routes. Never assume raw ports, bind ports manually, or
probe `ws://127.0.0.1:<port>`. Start with `pnpm dev`; discover URLs with
`pnpm portless:list`.

The dev server doesn't watch `node_modules`: pnpm hardlinks its shared store into
every worktree, so another worktree's install would otherwise restart this one's
server and kill in-flight replies ([#817](https://github.com/haowjy/meridian-flow/issues/817)).
After installing, upgrading, or patching a package, run `pnpm dev:restart`.

Postgres is a plain `postgres:16` container; `DATABASE_URL` is the app seam. Use
noninteractive libpq authentication (`PGPASSWORD` or `-w`).

Dev stacks are the largest single consumer on a shared host — measured at 14.9 GB
across six worktrees, against ~9 GB for every test process running at the time,
with one active stack at 6.6 GB. Run `pnpm dev:stacks` before blaming the tests:
it reports each stack's memory and how long since its tmux session last produced
output. `pnpm dev:stacks --reap-idle <minutes> --yes` stops the stale ones, but
only when you ask: a stack belongs to whichever session started it.

Setup: [DEVELOPMENT.md](DEVELOPMENT.md). Dev tooling rules:
[tools/dev/AGENTS.md](tools/dev/AGENTS.md).

**Verify app behavior in the browser.** A runtime check, a probe, or a PR's
walkthrough or Before/After drives a real browser (`agent-browser`) and judges what
the screen shows, with the durable transcript as truth. `./mf` doesn't test the app:
it is a separate client over the API. Use it only to set up state (Works, threads,
seeded documents, mock-model scripts, queued controls) and to read durable state
(`thread view`, `thread events`, `thread context`, `log`, `doc read`). Never cite
`./mf thread send` or `thread tail` output as evidence. Until
[#768](https://github.com/haowjy/meridian-flow/issues/768) lands, they can also report
another message's reply. See [docs/debugging.md](docs/debugging.md#set-up-and-read-with-the-cli).

## Build and test

`pnpm check` is the full gate. `pnpm test:db` forces the DB suite.
`pnpm test:all` runs unit and managed DB tests together.

There is no target case count. `tools/ci/test-budget-reporter.ts` holds the
suite with a ratchet instead: the expanded case count per test file (including
`it.each` rows and browser-device variants) may not grow against
`tools/ci/test-case-baseline.json`. A new file, or a grown count, fails the run.
Refresh the baseline deliberately with `TEST_BUDGET_UPDATE=1 pnpm test` when the
growth is intended, so the increase is a reviewable line rather than silent
drift. Skips, exclusions, and bundling unrelated cases satisfy neither the
ratchet nor the ceilings below.

The reporter also enforces a **wall-clock** and a **memory** ceiling.

- Memory blocks on every run, CI or not: it is a property of the suite, not of
  how busy the machine is. The reporter samples the whole process tree and fails
  past `TEST_MEMORY_CEILING_MB` (default 4096).
- Wall time blocks only in CI. On a shared host the identical 2,414 cases have
  measured between 45 s and 104 s, so a blocking local ceiling would be the
  flake it exists to catch. `TEST_DURATION_CEILING_SECONDS` defaults to 150 for
  the unit suite and 600 for the DB suite, which runs serially in CI; it overrides
  both, and `TEST_DURATION_CEILING_STRICT=1` blocks locally too.
- Peak memory is `base + workers × module graph`, so it tracks worker count far
  more than file count: `apps/app` alone (208 files) peaks the same as all 449,
  and `apps/server` reaches 3.5 GB with no jsdom at all. Deleting tests will not
  lower a peak. Measured, on a 24-core host: 8 unit workers 3.0 GB, 12 workers
  4.0 GB, 24 workers 6.7 GB and a flake; 4 DB fork workers 3.5 GB, 8 workers
  6.0 GB and a settlement flake. Never raise a worker count without measuring.

Write few unit tests: a new test must protect a named risk that no KB decision
and no probe already covers. A test whose only content is a decision already
recorded in the knowledge base, or a step a browser recipe already drives,
duplicates that decision rather than covering the code: delete it in the change
that lands the decision that supersedes it, and prefer pruning a weaker
duplicate to adding another layer. To verify a change, prefer probes,
end-to-end smoke scripts and written manual-testing steps in the
[runtime probe catalog](docs/qa/README.md); add or update the recipe that
covers what you changed. Contracts, markup, and DB suites reuse worker module caches:
no module/global mocks there. Keep test data and connections instance-owned;
DB rollback/FK resets, not fresh module loading, isolate persisted state.

## Git workflow

Commit often, one self-contained change at a time.

A human merges product changes into `main` or `staging` unless explicitly
instructing the agent to merge. Merges between working branches need no gate.
Documentation-only changes commit directly to `main`; never open a PR only for
documentation. This includes `AGENTS.md`, `.context/`, KB, and the Meridian Flow
docs repository.

Prune a worktree as soon as its branch merges, whether into `main`, `staging`,
or a longer-lived integration branch — `pnpm dev:prune-worktrees -- --target
<work-id|path|branch|pr> --dry-run` (see [tools/dev/AGENTS.md](tools/dev/AGENTS.md)).
Don't defer this: if the integration branch is later squash-merged, none of
its side-lane branches remain provable as merged by PR match or by ancestry,
and only a human who tracked the actual history can confirm by hand that they
are safe to remove.

**Clean up as soon as you're done with something.** Idle dev stacks, databases and
checkouts waste the machine's memory, CPU and disk. When a worktree, dev stack, probe,
review checkout or temporary branch has done its job:

1. Stop its dev stack with `pnpm dev --stop`.
2. End anything still running from it (the Nx daemon, `agent-browser` sessions, watchers).
3. Remove the worktree, its database and its merged branch with
   `pnpm dev:prune-worktrees -- --target <branch|path>`.
4. For a detached checkout the tool refuses, run `pnpm dev --stop` in it, then
   `git worktree remove` it, and drop its database with `pnpm dev:gc-dbs`.

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
[model-work-switch]: apps/server/server/domains/runtime/.context/tools.md#permissions
