# Meridian Flow — Agent Instructions

> **CURRENT STATE — v3 Full-Stack Rebuild** *(temporary; delete this banner once
> the rebuild stabilizes).* Ground-up rebuild, **TypeScript throughout**
> (replacing the prior Go backend) — chosen to make the codebase easier to
> change. Key decisions: canonical **Yjs** collab engine with the voluma-derived
> exact-text edit pipeline + **TipTap (ProseMirror)** / y-prosemirror on
> `Y.XmlFragment`; **agent definitions** (Mars `.md` packages) replace skills;
> **credits-only** billing gate; linear turns; event journal; Yjs persistence;
> **Drizzle ORM** over Postgres; Supabase auth (JWKS) + dev Postgres.
>
> No real users or data yet, and **no backwards compatibility** — change schemas
> freely, delete what's unused, and never add a compat shim or alias (rename or
> replace the real thing instead).

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
restraint).

Meridian-specific: the primary writer primitive is a **Project** (a serial /
book / body of work and everything scoped under it; formerly "workbench" — now
fully renamed).

## Conventions

**Layering.** Apps are thin shells — business logic lives in packages or server
domains, never in route handlers. Don't import across packages in ways that
bypass their public exports.

**Ports & adapters.** Protocol boundaries are explicit port interfaces; domain
logic depends on ports, never concrete adapters. Adapter/provider choice is
config-driven DI at the composition root, not hardcoded. Layout is
`domain/` + `ports/` + `adapters/` where the seam earns it; new/growing domains
converge on it.

**Package naming.** Every package fits one category below, or the name is wrong
(examples illustrate the pattern; not all are extracted yet):

| Suffix / pattern | What it means | Examples |
|---|---|---|
| **Domain noun** | First-class domain concept; state, types, persistence | `projects`, `threads`, `collab` |
| **`*-system`** | Foundational machinery other modules consume | `package-system` |
| **`*-runtime`** | Executes things against a substrate (FS, network, services) | `tool-runtime` |
| **`*-gateway`** | Brokers to external systems with provider abstraction | `model-gateway` |

**Tooling.** `pnpm` (not npm); Biome for lint/format; Nx for task orchestration.
No raw hex/color outside `design-tokens`.

**File headers.** At the top of each file, a short description: what it's *for*
and any key decisions tied to it.

## Cross-cutting invariants

Two invariants that silently corrupt data if violated:

- **`contracts` is JSON-natural** — types survive
  `JSON.parse(JSON.stringify(x))` unchanged: string IDs/dates, union-literal
  enums; no `Date`/`BigInt`/branded types on the wire.
- **`prosemirror-schema` is shared by both sides** — the server collab adapter
  and the frontend TipTap editor must build **structurally identical** schemas,
  or y-prosemirror corrupts the CRDT.

## Documentation layers

Knowledge is layered by need — put it where agents look for it, and never in two
places (see `/qi-layer`):

- **AGENTS.md** (per directory) — the *intent layer*: mental model, constraints,
  invariants, anti-patterns; what to understand before touching files here. Not a
  file index or routing table.
- **`.context/CONTEXT.md`** (beside the code) — reference depth: contracts,
  architecture, rationale, read on demand.
- **KB** (`meridian context kb`, git-backed via `meridian.toml` `[context.kb]`) —
  cross-cutting concepts no single directory owns, including `decisions/`.
- **Active work item** (`meridian work current`) — in-progress design decisions.
- **docs/** — user-facing docs.

Keep repo-root markdown thin: frame and pointers, not duplicated detail; don't
redefine canonical terms in root docs — link to the KB.

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

## Dev environment (portless — read before running or probing anything)

Dev does **not** use raw ports. Apps are served by **portless** at HTTPS
`*.localhost` URLs. Do **not** assume `localhost:3000`, bind ports by hand, or
probe `ws://127.0.0.1:<port>` — that bypasses the real proxy/TLS path.

- **Live URLs:** `pnpm portless:list`
- Run the stack: `pnpm dev` (worktree-scoped tmux). Stuck? `pnpm dev:restart`.
- TLS for curl/node: `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem`

## Local Supabase (database + auth)

Dev Postgres and `auth.users` run via Supabase CLI. App schema is Drizzle in
`packages/database` (not `supabase/migrations`).

```bash
pnpm supabase:start      # Docker: API :54421, Postgres :54422, Studio :54423
pnpm supabase:env        # print keys → copy into .env from .env.example
pnpm bootstrap           # auth user + db:migrate + apply-functions + seed project
pnpm db:migrate          # apply Drizzle migrations (packages/database)
pnpm db:apply-functions  # sync PL/pgSQL from packages/database/src/functions/
pnpm db:generate         # generate migration SQL from schema changes
pnpm db:studio           # drizzle-kit studio
```

See [supabase/README.md](supabase/README.md) and
[packages/database/README.md](packages/database/README.md).

## Build and test

`pnpm check` is the full gate: lint + negative-space + typecheck + test + graph.
Individual scripts (`lint`, `typecheck`, `test`, `dev`, `db:*`) are in
`package.json`. E2e needs the portless CA:

```bash
NODE_EXTRA_CA_CERTS=~/.portless/ca.pem \
  pnpm --filter @meridian/app exec playwright test -c e2e/playwright.auth.config.ts
```

## Commit discipline

Commit continuously as you develop — frequent, small, logically-scoped commits
create a verifiable history trail where each step is independently reviewable and
revertible. After each self-contained change that passes checks
(typecheck / lint / tests), commit it. Don't accumulate large uncommitted work.
(This governs local commit cadence; opening PRs and pushing remain separate,
deliberate decisions.) Hooks + worktree `lefthook install`: see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Cross-repo linking

- Links into the docs repo ([meridian-flow-docs]) use full GitHub URLs.
- Same-repo links use relative paths.
- Prefer reference-style markdown links.

[meridian-flow-docs]: https://github.com/haowjy/meridian-flow-docs

## Agent spawning

`meridian spawn` for delegated work; harness-native `Explore`/`Plan` and
Read/Grep/Glob/Bash for quick lookups. See `/meridian-spawn` for flags and
coordination.
