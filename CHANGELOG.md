# Changelog

## [Unreleased]

### Added
- Added Nitro global typings and documented remaining exact-path parity categories.
- Added server DB/smoke Vitest project configs adapted to Meridian package aliases and opt-in DB gates.
- Added thread projector, subagent-create, event-hub replay, and snapshot parity coverage.
- Added thread upload document/import parity coverage plus uploads domain context notes.
- Added Supabase request-auth route-boundary parity coverage.
- Added the authenticated Home route parity file under the pathless auth layout.
- Added collab DocumentSyncService parity coverage for markdown/code mirrors, persistence rollback, checkpoint restore, and transport updates.
- Added opt-in Drizzle collab document-store conformance coverage gated by `RUN_DB_TESTS` and `DATABASE_URL`.
- Added opt-in Drizzle thread repository conformance coverage gated by `RUN_DB_TESTS` and `DATABASE_URL`.
- **server/threads:** add pre-bake current-agent rebinding to repository adapters for upstream parity.
- Added thread repository/event-journal conformance suites for the in-memory adapter.
- Added structural Checkpoint renderer parity coverage for artifacts, live preview slots, forms, and resolved summaries.
- Added Meridian-adapted app context docs, e2e pg typings, and database schema compatibility paths for upstream exact-path parity.
- Added portless Playwright workbench-route smoke configs for mobile shell selection, chat virtualization, and ProcessDisclosure verification.
- Added persisted Drizzle workbench preferences with Supabase-backed conformance coverage.
- Added a Meridian Supabase/Postgres workbench-domain smoke script for repository runtime checks.

- **server/context:** port Meridian-adapted workbench context trees, uploads, figures, object-store reads, results rail repositories, and no-provider context factories with Supabase/Drizzle storage.
- **v3 parity:** port upstream collab/context/preference adapter conformance coverage, app proto routes, results-rail tests, and the marketing/waitlist app into Meridian names.
- **app/server:** add Meridian/Supabase runtime config, auth redirect, logout, and callback route surfaces matching the upstream app-server structure.
- **server/routes:** port upstream workbench, thread, package catalog, agent catalog, preferences, package install/update/export, model-debug, and readiness route surfaces with Meridian/Supabase composition wiring.
- **server/context:** port upstream context URI/router and ContextFS primitives with a generic no-execution backing-store fault vocabulary.
- **app/tests:** port upstream thread-store, session reducer, editor schema, chat rendering, workbench lifecycle, and deferred-chat regression coverage.
- **prosemirror-schema:** align the shared server schema with the richer TipTap editor nodes for figures, images, math, and tables.
- **app/library:** port upstream Library/package install UI, agent package APIs, related query hooks, and agent-mode helpers with Meridian naming.
- **server/workbenches:** port upstream workbench/work repository domain structure, thread-creation work touch coverage, and additional runtime loop/core-handler regression tests.
- **runtime:** split Meridian-owned permission gates into upstream-style modules and port gateway adapter/integration coverage with Meridian reasoning metadata.
- **server/packages:** port upstream package-domain install/update/preview/library helpers, zip export, skill-link reconciliation, and conformance/unit coverage with Meridian naming.
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

- **server/context:** align Results rail wire fields with the app, share `user://` context across a user personal project, and route object checkpoint artifacts into Results.
- **server/build:** align copied workbench user provisioning with Supabase auth IDs so Nitro production build resolves database exports.
- **www:** move waitlist persistence onto the shared Drizzle migration flow and align public copy with Meridian Flow’s fiction-writing positioning.
- **www:** use the exported Meridian design-token stylesheet so the marketing app production build resolves package exports.
- **server:** activate the copied upstream turn orchestrator on the production message route, adapt its Drizzle repositories to Meridian Flow's current Supabase/Postgres schema, and restore live WS/cold replay smoke coverage.
- **dev:** ignore generated portless dev logs.
- **server:** serialize Yjs document commits with markdown projection/activity updates and preserve agent attribution for persisted editor updates.
- **database:** enforce conversation roots, active leaf, session context thread scope, and purchase subscription gates in DB triggers/indexes.
- **database (p113):** `usage_event_id` required for consumption; Drizzle `usage_breakdown` default `'{}'` matches DB.
- **contracts:** `UsageBreakdown` types and `parseUsageBreakdown` for flat `model_responses.usage_breakdown` JSONB.
- **dev:** Collab Supabase (`54422`), `.env.example`, bootstrap pipeline (`db:migrate` → `db:apply-functions` → Drizzle seed).

### Changed
- **app/routes:** replace the placeholder public app index with the authenticated Home index route to avoid duplicate root route generation.

- **app:** wrap authenticated routes in the workbench query/store/transport providers so `/workbench/:id` and `/chat/:id` run the ported workspace shell.
- **docs:** record exact-path parity mappings for the marketing app and the intentionally excluded Python/runtime-provider tooling.
- **docs:** align product-facing brand references on Meridian Flow.
- **dev:** `AGENTS.md` documents `db:migrate`, `db:apply-functions`, `db:studio`, and bootstrap flow.

### Chore

- Remove stale execution-provider preview wording from checkpoint comments.
- Remove copied upstream provenance wording from dev tooling comments.
- Add upstream-derived Nx graph and negative-space checks to keep rejected auth adapter, editor-transport shortcut, and removed execution runtime out of v3.
- Add [DEVELOPMENT.md](DEVELOPMENT.md) (setup, `lefthook install --reset-hooks-path` for worktrees, commit discipline).
- Ignore `.nx/` cache; wire lefthook pre-commit (biome + typecheck) and pre-push (database tests).
- Add `.cursor/rules/commit-phase-discipline.mdc`; fix root `vitest.config.mts` project list.
- Biome format pass on database, contracts, and dev tooling.
