# Meridian Flow — Agent Instructions

> **v3 full-stack rebuild.** TypeScript with Yjs + TipTap, Drizzle over Postgres,
> WorkOS AuthKit, and credits-only billing. There are no real users or data.
> Change schemas freely, delete unused code, and never add compatibility shims.

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
[trust ruling](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/trust-the-llm-mission.md).

## Engineering principles

**Load `/dev-principles` before planning or changing code.** It is the source
for simplicity, boundaries, naming, deletion, consistency, and testing
restraint. Make the code easy to change.

**Design reusable modules.** Give modules deep public interfaces and keep
app-specific wiring outside them so they can become shared libraries later.

**Fix structural debt in the same PR.** Do not defer parallel hierarchies,
leaking abstractions, shallow modules, split ownership, or obvious
simplification.

**Writer primitives:** a **Project** is a serial, book, or body of work. A
**Work** is a task-scoped editing context within a project; it groups threads,
owns shared drafts, carries a goal, and holds `scratch://` context. When New Chat
omits a Work, the server resolves its narrow persisted fallback transactionally.
A chat's Work is fixed at creation; later surfaces display that binding and do
not control it. The checkout still contains writer/LLM rebind paths from the
superseded parity design; treat them as divergence to remove, not precedent.
“Current Work” names only an existing thread's binding. Fallback resolution,
Work-detail routing, and selected-chat navigation are distinct states and actions.
The schema is `works` +
`thread_works`; every new project receives a
concrete default Work, and writers can create and manage additional Works from
the dedicated Work screen.

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
[copy separation decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-copy-separation.md).

**Debugging.** Follow [docs/debugging.md](docs/debugging.md). Query existing
evidence before adding a signal. Use a marked console probe for a one-off; use
`EventSink` for a signal another agent will need. `pnpm check` blocks temporary
probes. The guide also covers browser evidence and cleanup. `EventSink` is
diagnostic evidence, not product feature tracking or analytics.

## Knowledge and structure

This is a TypeScript monorepo. `apps/app`, `apps/server`, and `apps/www` are
shells over `packages/` and `apps/server/server/domains/`; dev and CI scripts
live in `tools/`. See [.context/CONTEXT.md](.context/CONTEXT.md) for the root
architecture.

Before reading source in an area:

1. Run `meridian qi graph <path>` for its `AGENTS.md` chain and
   `.context/CONTEXT.md`.
2. Read that guidance for intent, contracts, and invariants.
3. Use `ls` and source to confirm current structure.

Load `/knowledge-layers` before placing durable knowledge and `/qi-layer`
before editing `AGENTS.md` or `.context/`. Update the relevant `AGENTS.md`,
`.context/`, or KB material when a change shifts the mental model, contracts, or
decisions.

## Command output

Use `rtk` for noisy human-readable commands: `rtk git diff`, `rtk git status`,
`rtk rg "<pattern>"`, and `rtk pnpm test`. Use raw commands for exact or
machine-readable output. If `rtk` is unavailable, run the raw command and say
so.

## Dev environment

Dev uses Portless HTTPS routes. Never assume raw ports, bind ports manually, or
probe `ws://127.0.0.1:<port>`. Start with `pnpm dev`; discover URLs with
`pnpm portless:list`.

Postgres is a plain `postgres:16` container; `DATABASE_URL` is the app seam. Use
noninteractive libpq authentication (`PGPASSWORD` or `-w`).

Setup: [DEVELOPMENT.md](DEVELOPMENT.md). Dev tooling rules:
[tools/dev/AGENTS.md](tools/dev/AGENTS.md).

## Build and test

`pnpm check` runs lint, negative-space, typecheck, unit tests, graph checks, and
the DB suite when local Postgres is reachable. An unreachable Postgres is a
loud skip; use `pnpm test:db` when the DB gate must run.

Runtime changes also require a real probe before merge: start the full stack,
exercise the affected workflow, inspect logs, streams, and DB state, and compare
with a baseline. The probe verdict is the runtime merge gate.

## Git workflow

Commit each self-contained change after its checks pass. When a feature branch
is complete and `pnpm check` is green, push it, open or update its PR, report it,
and stop.

A human merges into `main` or `staging` unless explicitly instructing the agent
to merge. Merges between working branches need no gate. Docs-only `AGENTS.md`,
`.context/`, and KB changes may commit directly to `main`.

Never switch the branch of a checkout you do not own. From the primary
checkout, create another branch under the sibling worktree root, then pass its
path to spawns with `--task-dir`:

```bash
git worktree add ../meridian-flow.worktrees/<name> -b <branch> <base>
```

Clean one merged or abandoned lane from a different checkout:

```bash
pnpm dev:prune-worktrees -- --target <work-id|path|branch|pr> --dry-run
```

Inspect the plan before running it without `--dry-run`. Do not use `--auto` for
routine cleanup.

## Links

- Use full GitHub URLs for the [Meridian Flow docs repository][meridian-flow-docs].
- Use relative links within this repository.
- Prefer reference-style links.

[meridian-flow-docs]: https://github.com/haowjy/meridian-flow-docs
