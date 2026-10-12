# @meridian/server

Nitro API/WebSocket service. Domains live under `server/domains/<domain>/{domain,ports,adapters}` where practical.

- Keep route handlers thin; compose repositories/services in `server/lib/app.ts`.
- Put non-trivial route logic in testable `server/lib/*-route.ts` route-core helpers; Nitro route files authenticate, parse, delegate, and serialize.
- Domain logic depends on ports, not concrete Drizzle/provider adapters.
- A plain `postgres:16` Docker container provides local Postgres; app schema and functions live in `@meridian/database`. Auth is WorkOS AuthKit.
- Do not reintroduce external package-execution runtime paths.
- Thread orchestration emits/persists through the copied event/journal/read-model pipeline.
- Model-facing Work context describes only the thread's primary Work. Metadata and lifecycle
  refreshes target threads whose primary `thread_works` row names the changed Work.
- Project-scoped API routes live under `/api/projects` and owner-gate through `requireProjectOwner` (`domains/projects/project-access.ts`). A route that reads or changes a document also asks the file policy (`requireFileGrant`, then `withEditGrants` around the write, from `lib/file-access-http.ts`); lists drop rows `listAccess` leaves out. See [file-policy](server/domains/file-policy/.context/CONTEXT.md).
- A new write seam starts its transaction with `lockSeamWorks` before any advisory or document lock. A new entry point for agent writes binds a grant; only the journal catches one that doesn't.
- `AppServices.repos` and `AppServices.hub` are upstream-compatible aliases for `threadRepos` and `threadEventHub`; keep the compatibility seam explicit.

- DB tests follow the shared [isolation policy](server/test-support/AGENTS.md): rollback for single-connection cases, FK-ordered DELETE when committed state must cross connections. Run them with `pnpm test:db`.
