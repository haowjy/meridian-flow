# Changelog

## [Unreleased]

### Added

- **app:** port upstream API route ownership and structured Meridian API error tests.
- **server:** port upstream observability and storage adapter tests for JSONL/in-memory event sinks and object-store adapters.
- **server/docs:** add adapted server architecture context, domain README, and deploy documentation for `MERIDIAN_API_ORIGIN`.
- **app:** copy upstream app context docs, app manifest/icons/screenshots, components config, and Supabase-adapted production start-env validation.
- **app/dev:** port upstream app Vite dev-control plane, Lingui config, global CSS bridge, SSR externalization seam, and portless API proxy with Meridian/Supabase naming.
- **runtime:** port upstream gateway, tool-registry, tool-executor, serialization, and model-request-debug tests with Meridian/Supabase naming and no rejected execution runtime.
- **dev:** add repo-level context docs, GitHub CI/deploy stubs, direnv/node-version files, deploy runbooks, and a Meridian-adapted model-gateway smoke harness from the upstream repo shape.
- **v3 parity:** copy executable upstream runtime, thread, package, billing, storage, preferences, transport, stores, chat, and workspace surfaces into Meridian Flow with Supabase/Postgres.
- **dev:** add Supabase-adapted env/database helper modules and `dev:db:*` wrappers matching the upstream dev control-plane shape.
- **v3 parity:** add upstream-structure skeletons and colocated context guidance for dev tools, server domains, and app project/chat surfaces while preserving Supabase/Postgres and removing the rejected execution runtime surface.
- **dev:** port upstream-style dev control plane with worktree-scoped tmux identity, local/tailscale/funnel modes, route validation, dry-run output, and preserved-mode restarts.
- **app/server:** replace placeholder editor transport with TipTap/y-prosemirror bound to persisted Yjs documents, binary `/ws/yjs` sync, and cold-replay smoke coverage.
- **app:** add Phase 5 project workspace shell with default bootstrap, chat streaming over `/api/threads/ws`, chapter context load, `/ws/yjs` subscription, and portless Playwright smoke coverage.
- **app/server:** add Phase 7 final vertical-slice e2e coverage for AG-UI streaming edits, live Yjs editor updates, and visible agent attribution metadata.
- **server:** add Phase 6 runtime tool registry, message-driven chapter edits through ContextPort/DocumentSyncService, Anthropic gateway seam, and checkpoint/spawn smoke coverage.
- **server:** add Phase 3 thread runtime POST + authenticated WebSocket event hub with AG-UI catchup/replay smoke coverage.
- **server:** add Phase 4 default bootstrap, work context read/write, DocumentSyncService Yjs persistence, and minimal `/ws/yjs` live update smoke coverage.
- **auth:** add Supabase Phase 2 app/server auth gates, dev-login, portless Playwright auth setup, and protected auth smoke route.
- **v3:** add TanStack/Nitro app-server skeleton and Phase 0 contracts surface for the upstream parity plan.
- **database:** add Phase 1 thread event schema amendments plus Drizzle event-journal append/read adapter tests.
- **database:** v3 Drizzle schema (26 tables + `credit_balances` view), single fresh `0001_initial` migration, `consume_credit_lots_fifo` with debt-lot overspend, integrity triggers, `pg_trgm` indexes, `db:apply-functions`, integration tests.

### Fixed

- **server:** activate the copied upstream turn orchestrator on the production message route, adapt its Drizzle repositories to Meridian Flow's current Supabase/Postgres schema, and restore live WS/cold replay smoke coverage.
- **dev:** ignore generated portless dev logs.
- **server:** serialize Yjs document commits with markdown projection/activity updates and preserve agent attribution for persisted editor updates.
- **database:** enforce conversation roots, active leaf, session context thread scope, and purchase subscription gates in DB triggers/indexes.
- **database (p113):** `usage_event_id` required for consumption; Drizzle `usage_breakdown` default `'{}'` matches DB.
- **contracts:** `UsageBreakdown` types and `parseUsageBreakdown` for flat `model_responses.usage_breakdown` JSONB.
- **dev:** Collab Supabase (`54422`), `.env.example`, bootstrap pipeline (`db:migrate` → `db:apply-functions` → Drizzle seed).

### Changed

- **docs:** align product-facing brand references on Meridian Flow.
- **dev:** `AGENTS.md` documents `db:migrate`, `db:apply-functions`, `db:studio`, and bootstrap flow.

### Chore

- Remove copied upstream provenance wording from dev tooling comments.
- Add upstream-derived Nx graph and negative-space checks to keep rejected auth adapter, editor-transport shortcut, and removed execution runtime out of v3.
- Add [DEVELOPMENT.md](DEVELOPMENT.md) (setup, `lefthook install --reset-hooks-path` for worktrees, commit discipline).
- Ignore `.nx/` cache; wire lefthook pre-commit (biome + typecheck) and pre-push (database tests).
- Add `.cursor/rules/commit-phase-discipline.mdc`; fix root `vitest.config.mts` project list.
- Biome format pass on database, contracts, and dev tooling.
