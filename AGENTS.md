# Meridian Flow — Agent Instructions

> **v3 Full-Stack Rebuild** — ground-up TypeScript rebuild (replacing the prior
> Go backend). Context-URI + model-gateway cleanse has **landed** (`h/v3` branch):
> unified `ContextPort`, scheme vocabulary, M:N thread↔work model, registry-
> sourced pricing, billing-correct cancel. Migration-snapshot debt resolved.
> Key decisions: **Yjs** collab engine with voluma-derived exact-text edit
> pipeline + **TipTap (ProseMirror)** / y-prosemirror on `Y.XmlFragment`;
> **agent definitions** (Mars `.md` packages) replace skills; **credits-only**
> billing gate; linear turns; event journal; Yjs persistence; **Drizzle ORM**
> over Postgres; WorkOS AuthKit + plain Docker postgres:16 in dev.
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

## Context-URI scheme vocabulary

Durable Project content vs ephemeral Work scratch — see `work-model.md` in the
cleanse design package and `kb/decisions/` for cross-cutting terms:

| Scheme | Scope | Lifecycle | Notes |
|---|---|---|---|
| `manuscript://` | project | durable | The book; one per Project. **Bare-path default.** |
| `kb://` | project | durable | Agent KB + import target (`kb://imports/…`) |
| `user://` | user (cross-project) | durable | Personal files |
| `work://` | **work** (`<workId>` authority) | ephemeral | Agent working memory |
| `uploads://` | **work** (`<workId>` authority) | ephemeral | Per-Work upload target |

**Deleted:** `fs1://` (sandbox-era), `work://.results` (promotion cruft).  
**No `results://` scheme** — promotion results → `work://<workId>/results/…`.

Bare paths default to `manuscript://`. Work-scoped URIs carry a `<workId>`
authority; omitted authority resolves to the thread's primary Work.

## M:N thread↔work model

`threads.workId` is **dropped**, replaced by `thread_works` membership join
(one primary per thread). A thread addresses multiple Works:
- **Work authority in URIs** — `work://<workId>/…`, `uploads://<workId>/…`
- **Primary Work as default** when `<workId>` is omitted in work-scoped schemes.
- **Membership gate** — work-scoped browse requires ownership/membership.
- M:N shapes shipped; multi-Work orchestration + GC/handoff deferred.

## Gateway / pricing

- **One `MODEL_REGISTRY`** — config + pinned pricing, single-sourced from
  `registry.ts`. The flat `MODEL_TOKEN_RATES` table is **deleted**.
- **Pricing layers** — pinned rates (direct providers) + provider-reported-cost
  (OpenRouter). `PinnedModelRate` is **gateway-local** (defined in `registry.ts`);
  billing imports it from the gateway — the gateway never imports billing.
- **OpenRouter** — restored via `openai-compatible` adapter (config entry).
- **Billing-correct cancel** — soft-cancel/drain + cancel-on-disconnect
  (connectionToken ownership). Provider-reported cost persisted on
  `model_responses.providerRequestId` / `priceSource` / `pricingSnapshot`.
  Failed turn generator → `turn.error` (no stuck "streaming").

## Dev-auth / test-isolation conventions

- `pnpm bootstrap` applies schema only (`db:migrate` + `db:apply-functions`) — no
  user or project seed. Dev identity is provisioned on first sign-in via
  `UserRepository.ensureUser` (idempotent upsert on `external_id`); onboarding
  creates the first project. `WORKOS_DEV_LOGIN_USER_ID` is the WorkOS id used by
  e2e lookups, not by bootstrap.
- DB-backed tests must use an **isolated fixture identity** (dedicated email,
  NOT `TEST_USER_EMAIL`/`test@meridian.dev`) and `RUN_DB_TESTS` must target a
  dedicated throwaway DB, never the dev DB.
- No `auth` schema — identity is app-owned `public.users`.
- Migrations squashed to a single baseline (`0000_careless_rockslide.sql`);
  `pnpm db:generate` works again.

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
- **`pnpm dev` defaults to `--tailscale`** (shares app+server over the tailnet).
  Opt out with `pnpm dev --no-tailscale` (or `pnpm dev:local`, or
  `PORTLESS_TAILSCALE=0`) for localhost-only; `--funnel` for public sharing.
- TLS for curl/node: `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem`

## Local Postgres (provider-agnostic)

Dev Postgres runs via a plain `postgres:16` Docker container. App schema is
Drizzle in `packages/database`. Auth is **WorkOS AuthKit**; identity is
app-owned `public.users`. The DB seam is `DATABASE_URL` only — point it at any
Postgres (including a hosted Supabase Postgres) by changing the URL.

```bash
pnpm dev:infra            # docker compose -f tools/dev/docker-compose.yml up -d
pnpm bootstrap            # migrate + apply-functions (schema only)
pnpm db:migrate           # apply Drizzle migrations (packages/database)
pnpm db:apply-functions   # sync PL/pgSQL from packages/database/src/functions/
pnpm db:generate          # generate migration SQL from schema changes
pnpm db:studio            # drizzle-kit studio
pnpm db:reset             # drop/recreate public schema + re-migrate
pnpm dev:infra:down       # stop the container
```

Full wipe: `pnpm dev:infra:down` + remove the `meridian-dev_meridian-postgres-data`
Docker volume + `pnpm bootstrap`.

`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54422/meridian` (in
`.env`; `.env.example` documents it).

See [tools/dev/.context/CONTEXT.md](tools/dev/.context/CONTEXT.md) and
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
