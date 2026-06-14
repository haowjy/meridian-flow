# @meridian/server

Nitro API/WebSocket service. Domains live under `server/domains/<domain>/{domain,ports,adapters}` where practical.

- Keep route handlers thin; compose repositories/services in `server/lib/app.ts`.
- Put non-trivial route logic in testable `server/lib/*-route.ts` route-core helpers; Nitro route files authenticate, parse, delegate, and serialize.
- Domain logic depends on ports, not concrete Drizzle/Supabase/provider adapters.
- Supabase owns local auth/Postgres infrastructure; app schema and functions live in `@meridian/database`.
- Do not reintroduce external package-execution runtime paths.
- Thread orchestration emits/persists through the copied event/journal/read-model pipeline.
- Project-scoped API routes live under `/api/projects` and owner-gate through `requireProjectOwner` (`domains/projects/project-access.ts`).
- `AppServices.repos` and `AppServices.hub` are upstream-compatible aliases for `threadRepos` and `threadEventHub`; keep the compatibility seam explicit.
