# @meridian/server

Nitro API/WebSocket service. Domains live under `server/domains/<domain>/{domain,ports,adapters}` where practical.

- Keep route handlers thin; compose repositories/services in `server/lib/app.ts`.
- Domain logic depends on ports, not concrete Drizzle/Supabase/provider adapters.
- Supabase owns local auth/Postgres infrastructure; app schema and functions live in `@meridian/database`.
- Do not reintroduce external package-execution runtime paths.
- Thread orchestration emits/persists through the copied event/journal/read-model pipeline.
