# Changelog

## [Unreleased]

### Added

- **database:** v3 Drizzle schema (26 tables + `credit_balances` view), single fresh `0001_initial` migration, `consume_credit_lots_fifo` with debt-lot overspend, integrity triggers, `pg_trgm` indexes, `db:apply-functions`, integration tests.

### Fixed

- **database:** enforce conversation roots, active leaf, session context thread scope, and purchase subscription gates in DB triggers/indexes.
- **database (p113):** `usage_event_id` required for consumption; Drizzle `usage_breakdown` default `'{}'` matches DB.
- **contracts:** `UsageBreakdown` types and `parseUsageBreakdown` for flat `model_responses.usage_breakdown` JSONB.
- **dev:** Collab Supabase (`54422`), `.env.example`, bootstrap pipeline (`db:migrate` → `db:apply-functions` → Drizzle seed).

### Changed

- **dev:** `AGENTS.md` documents `db:migrate`, `db:apply-functions`, `db:studio`, and bootstrap flow.

### Chore

- Add [DEVELOPMENT.md](DEVELOPMENT.md) (setup, `lefthook install --reset-hooks-path` for worktrees, commit discipline).
- Ignore `.nx/` cache; wire lefthook pre-commit (biome + typecheck) and pre-push (database tests).
- Add `.cursor/rules/commit-phase-discipline.mdc`; fix root `vitest.config.mts` project list.
- Biome format pass on database, contracts, and dev tooling.
