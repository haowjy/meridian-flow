# Meridian Flow

Meridian Flow is an agentic writing platform for fiction writers managing 100+ chapter web serials. No real users or user data. No backwards compatibility needed. Schema can change freely.

**Target user:** Fiction writers managing 100+ chapter web serials (xianxia, LitRPG, progression fantasy). Power users who write 5,000-10,000+ words per day across multiple ongoing serials. They need an editor that handles scale (hundreds of chapters, complex continuity) with AI assistance that understands narrative structure. Think Scrivener's power without its complexity cliff, plus AI that actually helps with writing craft.

See `$MERIDIAN_CONTEXT_KB_DIR/wiki/product/high-level/1-overview.md` for product details.

## v3 Full-Stack Rebuild (active)

Ground-up rebuild. TypeScript throughout. Design package lives in the active work item directory (`meridian work current`).

Key decisions: TypeScript backend (canonical Yjs, no hashline port), Milkdown (ProseMirror), Y.XmlFragment, agent definitions replace skills, credits-only billing gate, linear turns, Drizzle ORM.

## Where to Find Things

| Area | Location |
|------|----------|
| v3 Design | Work item dir (`meridian work current`) |
| Plans | `$MERIDIAN_CONTEXT_KB_DIR/plans/` |
| Knowledge base | `$MERIDIAN_CONTEXT_KB_DIR` (`meridian context kb`) |
| Decisions | `$MERIDIAN_CONTEXT_KB_DIR/decisions/` |

## Dev environment (portless)

Dev does **not** use raw ports. Apps are served by **portless** at HTTPS `*.localhost`
URLs. Do **not** assume `localhost:3000`, bind ports by hand, or probe
`ws://127.0.0.1:<port>` — that bypasses the real proxy/TLS path.

- **Live URLs:** `pnpm portless:list`
- Run the stack: `pnpm dev` (worktree-scoped tmux)
- TLS for curl/node: `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem`

## Monorepo architecture

TypeScript monorepo (pnpm + Nx). Apps are thin shells over domain packages.

| Directory | Purpose |
|-----------|---------|
| `packages/` | Shared TypeScript libraries (domain + contracts + support) |
| `apps/` | Deployable services (app, server, www) |
| `tools/dev/` | Dev scripts (tmux, portless, bootstrap) |
| `tools/ci/` | CI tooling (graph check, nx runner) |

### Package naming

Every package must fit one of these categories. If it doesn't, the name is wrong.

| Suffix / pattern | What it means | Examples |
|---|---|---|
| **Domain noun** | First-class domain concept; state, types, persistence | `projects`, `sessions`, `collab` |
| **`*-system`** | Foundational machinery other modules consume | `package-system` |
| **`*-runtime`** | Executes things against a substrate (FS, network, external services) | `tool-runtime` |
| **`*-gateway`** | Brokers to external systems with provider abstraction | `model-gateway` |

### Current packages

| Package | Purpose |
|---------|---------|
| `contracts` | Shared types — branded IDs, wire DTOs, WebSocket protocol, streaming events |
| `database` | Database initialization (Drizzle), Postgres utilities, schema |
| `design-tokens` | Warm-paper design tokens — colors, typography, spacing, shared primitives |

### Current apps

| App | Purpose |
|-----|---------|
| `app` | TanStack Start authenticated project workspace (React, Vite) |
| `server` | Nitro HTTP + WebSocket server |
| `www` | Landing / marketing site |

## Implementation constraints

### Ports and adapters

- Keep protocol boundaries explicit via **port interfaces** (in domain packages or `contracts`).
- Domain packages depend on ports, never on concrete adapters.
- Adapter/provider choice is **configuration-driven** (DI at composition root), not hardcoded.
- Keep provider-specific types out of core business logic.
- Each domain package follows: `src/domain/` (logic), `src/ports/` (interfaces), `src/adapters/` (implementations).

### General

- Apps are thin shells — business logic lives in packages, not in route handlers.
- Follow existing project structure; avoid cross-package direct imports that bypass exports.
- No raw hex/color values outside token files.
- `pnpm` (not npm). Biome for lint + format. Nx for task orchestration.

## Local Supabase (database + auth)

Dev Postgres and `auth.users` run via Supabase CLI. App schema is Drizzle in `packages/database` (not `supabase/migrations`).

```bash
pnpm supabase:start   # Docker: API :54421, Postgres :54422, Studio :54423
pnpm supabase:env     # print keys → copy into .env from .env.example
pnpm bootstrap        # auth user + db:migrate + apply-functions + seed project
pnpm db:migrate       # apply Drizzle migrations (packages/database)
pnpm db:apply-functions  # sync PL/pgSQL from packages/database/src/functions/
pnpm db:generate      # generate migration SQL from schema changes
pnpm db:studio        # drizzle-kit studio
```

See [supabase/README.md](supabase/README.md) and [packages/database/README.md](packages/database/README.md). Stop v2 `meridian/backend` Supabase first if ports clash (v2 uses `543xx`).

## Build and Test

```bash
pnpm check          # lint + typecheck + test (all packages)
pnpm lint           # biome check
pnpm typecheck      # nx typecheck across all packages
pnpm test           # vitest run
pnpm dev            # start dev environment (portless + tmux)
pnpm bootstrap      # dev auth user (after supabase:start + .env)
pnpm db:migrate     # Drizzle → local Postgres (DATABASE_URL port 54422)
pnpm db:apply-functions  # after migrate when editing src/functions/*.sql
pnpm db:studio
```

## Git Conventions

Commit after each testable state. Follow repository commit message style.

Hooks, worktree `lefthook install`, and phase-by-phase commits: [DEVELOPMENT.md](DEVELOPMENT.md).

## Agent Spawning

- `meridian spawn` for delegated work (coding, reviewing, testing, research)
- Harness-native Agent types (`Explore`, `Plan`) for quick lookups
- Harness-native tools (Read, Grep, Glob, Bash, Edit, Write) for quick operations
