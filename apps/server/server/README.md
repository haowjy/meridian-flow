# Server domain modules

Modular monolith layout under `apps/server/server/`:

| Directory | Role |
|---|---|
| `lib/` | Nitro composition root, auth/env/db helpers, WS route shell |
| `domains/projects/` / content tables | Project/work ownership and access |
| `domains/context/` | ContextPort router plus context/file adapters |
| `domains/threads/` | Thread/turn/block repositories, event journal, thread event hub |
| `domains/runtime/` | Orchestrator loop, model gateway, tool registry/executor |
| `domains/packages/` | Installed package and agent/skill catalog surfaces |
| `domains/collab/` | Yjs/document sync scaffold |
| `domains/storage/` | Object store abstractions |
| `domains/billing/` | Credit ledger and usage accounting |

Import rules:

- Routes and `lib/app.ts` wire domains; domains do not import routes.
- Cross-domain imports go through each domain `index.ts` or explicit port surfaces.
- Shared types come from `@meridian/contracts/*` and persistence shape from `@meridian/database`.
- No new workspace packages for server domain code unless the boundary is truly reusable outside the server.
