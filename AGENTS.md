# Meridian

Agentic writing platform for fiction writers managing 100+ chapter web serials. No real users or user data. No backwards compatibility needed. Schema can change freely.

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
| **`*-runtime`** | Executes things against a substrate (FS, sandbox, network) | `tool-runtime` |
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
| `app` | TanStack Start authenticated workbench (React, Vite) |
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

## Build and Test

```bash
pnpm check          # lint + typecheck + test (all packages)
pnpm lint           # biome check
pnpm typecheck      # nx typecheck across all packages
pnpm test           # vitest run
pnpm dev            # start dev environment (portless + tmux)
pnpm bootstrap      # first-time setup (schema + seed)
```

## Git Conventions

Commit after each testable state. Follow repository commit message style.

## Agent Spawning

- `meridian spawn` for delegated work (coding, reviewing, testing, research)
- Harness-native Agent types (`Explore`, `Plan`) for quick lookups
- Harness-native tools (Read, Grep, Glob, Bash, Edit, Write) for quick operations
