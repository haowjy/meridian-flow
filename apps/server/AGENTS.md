# @meridian/server

Nitro API and WebSocket service. Domains live under
`server/domains/<domain>/`, split into `domain/`, `ports/` and `adapters/`
where the seam earns it. Composition, transport and cross-domain contracts:
[server architecture](.context/CONTEXT.md).

- Route files authenticate, parse, delegate and serialize. Non-trivial route
  logic goes in a testable `server/lib/*-route.ts` route core; services are
  composed in `server/lib/app.ts`.
- Domain logic depends on ports, never on concrete Drizzle or provider
  adapters. Schema and SQL functions live in `@meridian/database`; auth is
  WorkOS AuthKit.
- No external package-execution runtime.
- Thread orchestration emits and persists through the event, journal and
  read-model pipeline.
- Model-facing Work context describes only the thread's primary Work.
- Project routes live under `/api/projects` and gate on project ownership; a
  route that reads or changes a document also asks the
  [file policy](server/domains/file-policy/.context/CONTEXT.md).
- A new write seam starts its transaction with `lockSeamWorks` before any
  advisory or document lock. A new entry point for agent writes binds a grant;
  only the journal catches one that doesn't.
- DB tests follow the shared [isolation policy](server/test-support/AGENTS.md).
  Run them with `pnpm test:db`.
