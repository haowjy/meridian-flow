# Meridian Flow — Agent Instructions

> **v3 Full-Stack Rebuild** — ground-up TypeScript rebuild replacing the prior
> Go backend. Yjs collab + TipTap editor, Drizzle ORM over Postgres, WorkOS
> AuthKit, credits-only billing. No real users or data yet — **no backwards
> compatibility**: change schemas freely, delete what's unused, never add a
> compat shim.

## Mission

**Writers should spend their time writing, not fighting their tools.** Meridian
Flow makes creative-writing ideas flow faster — it helps fiction writers get the
story out of their head and onto the page, with AI that understands narrative
craft. Every architectural and product decision should survive the question:
*does this help a writer bring their idea to life faster?*

**Who it's for:** fiction writers managing 100+ chapter web serials (xianxia,
LitRPG, progression fantasy) at 5,000–10,000+ words/day — Scrivener's power at
that scale, without the complexity cliff.

## Engineering principles

**Load `/dev-principles` when planning or changing code** — it is the single
source for engineering values (simplicity, deep modules, separation of concerns,
naming discipline, commenting, aggressive deletion, consistency, testing
restraint). Core principle: make the code easy to change.

Modules should be written as if they are being prepared to be shared with other people to create useful, flexible, powerful libraries so that 1. we may eventually split the module out to share with others, and 2. so that we can get the flexibility and make our future lives easier when we want to change something.

**Structural improvements are never deferred.** When a review surfaces
architectural debt — parallel hierarchies, leaking abstractions, shallow
modules, split ownership — fix it in the same PR. Don't track it as a follow-up.
Code quality, refactors, and simplification are part of the work, not separate
from it. The cost of structural debt compounds; the cost of fixing it now is
bounded.

Meridian-specific: the primary writer primitives are **Project** (a serial /
book / body of work) and **Work** (a task-scoped editing context within a
project — groups threads, owns shared drafts, carries a goal, holds scratch
context via `work://` URIs). Schema: `works` table + `thread_works` M:N join.
Currently 1 default work per project; multi-work and writer-facing UI are
in progress.

## Agency

Default to acting on confident inferences; don't ask permission you don't need.
Before interrupting to ask the human. Code quality, refactors, deleting unneeded code and simplifying are just being good code citizens, you do not need permission. Make the code easy to change.

## Conventions

**Layering.** Apps are thin shells — business logic lives in packages or server
domains, never in route handlers. Don't import across packages in ways that
bypass their public exports.

**Ports & adapters.** Protocol boundaries are explicit port interfaces; domain
logic depends on ports, never concrete adapters. Adapter/provider choice is
config-driven DI at the composition root, not hardcoded. Layout is
`domain/` + `ports/` + `adapters/` where the seam earns it; new/growing domains
converge on it.

**Tooling.** `pnpm` (not npm); Biome for lint/format; Nx for task orchestration.
No raw hex/color outside `design-tokens`.

**Comments.** File headers: a short description of what it's *for*. Inline
comments: explain the *weird* — hidden constraints, non-obvious invariants,
workarounds. Don't explain what the code does; explain why it's surprising.

**Debugging.** Temporary console probes are allowed while diagnosing, but must
use the marked convention in [docs/debugging.md](docs/debugging.md) and be
deleted or converted to durable observability before push.


## Documentation

Load `/knowledge-layers` for where to put things. Load `/qi-layer` before
editing `AGENTS.md` or `.context/` files. Keep knowledge layers current as you
work — update `AGENTS.md`, `.context/`, and KB when your changes shift the
mental model, contracts, or decisions.

## Monorepo architecture

TypeScript monorepo (pnpm + Nx). `apps/` (app, server, www) are thin shells over
domain logic in shared `packages/` and server domains
(`apps/server/server/domains/`); dev/CI scripts live in `tools/`.

Don't memorize structure from this file — it rots. When working in a module,
start from colocated knowledge:

1. `meridian qi graph <path>` — surfaces the `AGENTS.md` chain + `.context/CONTEXT.md`
2. Read `AGENTS.md` for the frame/intent, then `.context/CONTEXT.md` for contracts, architecture, invariants
3. Then `ls` + raw source to confirm specifics

## Token hygiene for command output

Use `rtk` for noisy human-readable commands so agents spend context on signal,
not log volume: `rtk git diff`, `rtk git status`, `rtk rg "<pattern>"`,
`rtk pnpm test`, etc. Use raw commands when exact output is required
(machine-readable formats, pipes, snapshots, reproduction logs). If `rtk` is
unavailable, run the raw command and note that compressed output was missing.

## Dev environment

Dev uses **portless** (HTTPS `*.localhost`). Do **not** assume raw ports, bind
ports by hand, or probe `ws://127.0.0.1:<port>`. Run `pnpm dev` to start;
`pnpm portless:list` for live URLs. Postgres is a plain `postgres:16` Docker
container; `DATABASE_URL` is the only app seam. For libpq CLIs (`createdb`,
`psql`, `dropdb`), use noninteractive auth (`PGPASSWORD` or `-w`) — never let
them prompt.

**Local setup:** [DEVELOPMENT.md](DEVELOPMENT.md). **Editing `tools/dev`:** [tools/dev/AGENTS.md](tools/dev/AGENTS.md).

## Build and test

`pnpm check` is the full gate (lint + negative-space + typecheck + test + graph).

## Commit discipline

Commit continuously as you develop — frequent, small, logically-scoped commits
create a verifiable history trail where each step is independently reviewable and
revertible. After each self-contained change that passes checks
(typecheck / lint / tests), commit it. Don't accumulate large uncommitted work.
(This governs local commit cadence.) When a feature branch (never `main`) is
complete and passes the full gate (`pnpm check` green), push it and open/update
its PR without asking.

## Worktree discipline

**Never switch the branch of a checkout you don't own** — it may be shared. Need
another branch? Make a worktree (`git worktree add ../meridian-flow.worktrees/<name>
-b <branch> <base>`) and pass `--task-dir <worktree>` to spawns.

Clean up merged or abandoned work with `pnpm dev:prune-worktrees` from a
checkout you are not removing. Start with `--auto --dry-run` or
`--target <work-id|path|branch|pr> --dry-run`.

## Cross-repo linking

- Links into the docs repo ([meridian-flow-docs]) use full GitHub URLs.
- Same-repo links use relative paths.
- Prefer reference-style markdown links.

[meridian-flow-docs]: https://github.com/haowjy/meridian-flow-docs
