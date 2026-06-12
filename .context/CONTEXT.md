# Meridian Flow Repo — Architecture

This is the repo-local architecture overview for the v3 full-stack rebuild. It
tracks the code as shipped in this repository; cross-cutting rationale lives in
the Meridian KB.

## Module dependency graph

```mermaid
flowchart TD
  Projects[Projects + works]
  Workbenches[Workbench route surface]
  Auth[Supabase Auth + users]
  Packages[Agent packages]
  Runtime[Runtime orchestrator]
  Gateway[Model gateway]
  Threads[Threads]
  Context[Context + documents]
  Collab[Yjs collab]

  Auth --> Projects
  Auth --> Workbenches
  Workbenches --> Threads
  Workbenches --> Packages
  Projects --> Threads
  Runtime --> Threads
  Runtime --> Packages
  Runtime --> Gateway
  Runtime --> Context
  Context --> Collab
  Threads --> Projects
```

Acyclic at the domain level. `apps/server/server/lib/app.ts` is the composition
root that wires the runtime, thread repositories, gateway, event hub, package
repository, preferences, billing, projects/workbenches, and collab services.

## Harness composition

"Harness" is a concept, not a package. The harness is the top-layer stack:

```
domains/runtime + domains/threads + domains/packages + domains/projects + domains/context + domains/collab
```

| Domain area | Role in harness |
|---|---|
| `domains/runtime/loop` | Control loop: receives user messages, drives turns, streams events |
| `domains/runtime/gateway` | LLM access: provider-neutral generation/streaming |
| `domains/runtime/tools` | Tool registry/executor for Meridian-owned tools; no external execution runtime |
| `domains/packages` | Agent/package catalog and future package install surface |
| `domains/projects` | Project/work ownership and default bootstrap |
| `domains/workbenches` | upstream-parity workbench CRUD, work lists, and owner gates for workbench-scoped routes |
| `domains/context` | ContextPort router/adapters for agent-readable writing context |
| `domains/collab` | Yjs document sync and markdown projection |

## DI wiring pattern

Infrastructure dependencies are explicit ports. JSON-natural shared DTOs live in
`@meridian/contracts`; server-local behavioral ports live in their owning domain.
Concrete adapters live under `apps/server/server/*`. Wiring happens at the
composition root (`apps/server/server/lib/app.ts`).

**Rules:**

- Domain code depends on ports, never concrete adapters internally.
- Adapter/provider choice is configuration-driven at composition time.
- Provider-specific types stay inside adapters.
- Supabase is the local auth/Postgres substrate; Drizzle owns the app schema.
- No external package-execution provider/runtime is part of Meridian Flow v3.

## Support packages

| Package | Role | Constraints |
|---|---|---|
| `@meridian/contracts` | Shared JSON-natural types, IDs, protocol DTOs | Types only; no server logic |
| `@meridian/database` | Drizzle schema, migrations, Postgres functions | Persistence shape only; repos live in `apps/server` |
| `@meridian/design-tokens` | Warm-paper design tokens | CSS/token primitives only |
| `@meridian/prosemirror-schema` | Shared ProseMirror node/mark specs | Server and frontend schemas stay structurally identical |

## App layer

| App | Role | Key constraint |
|---|---|---|
| `apps/server` | Nitro HTTP + WebSocket server | One `AppServices` singleton; domains wired through ports |
| `apps/app` | TanStack Start authenticated workbench | Business logic lives in packages/server domains |
| `apps/www` | Public marketing site | Presentation shell for Meridian Flow |

## Documentation tier model

```
AGENTS.md            ← prescriptive rules and boundaries
.context/CONTEXT.md  ← architecture, contracts, invariants, conventions
KB                   ← cross-cutting decisions, vocabulary, durable product docs
```

Agents should read `.context/` before raw source files when entering an area.

## Upstream parity mapping notes

- Upstream `apps/web` is intentionally represented as `apps/www` in this repo, so exact-path audits should classify those paths as ported under the Meridian marketing app name rather than missing.
- The upstream root/Python SDK and `uv` files are intentionally not ported into tracked source for v3. Meridian Flow's runtime and dev tooling are TypeScript/pnpm/Nx; reintroducing a separate Python SDK/toolchain would be a new product/API decision, not parity work.
- Files from the rejected external execution-provider subsystem remain excluded by policy. Runtime tools operate through Meridian-owned context/project surfaces instead.
