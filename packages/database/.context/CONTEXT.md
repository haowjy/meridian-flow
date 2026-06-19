# @meridian/database — Postgres Contract

This package owns the Postgres contract: Drizzle schema, generated migrations,
PL/pgSQL functions, and the `createDb(DATABASE_URL)` factory. It has **no**
business logic and **no** ambient transaction context — domain persistence and
transaction propagation live in `apps/server`.

## Contracts

### Timestamp `mode` policy

Timestamp columns default to Drizzle **`Date` mode**. The shared helpers in
[`../src/schema/_shared.ts`](../src/schema/_shared.ts) (`createdAt`, `updatedAt`,
`softDeleteAt`) omit `mode`, so reads return JS `Date` objects.

The **only** `mode: "string"` exceptions (reads return ISO strings) are:

| Table | Column(s) | Source |
|---|---|---|
| `users` | `created_at`, `updated_at` | [`../src/schema/users.ts`](../src/schema/users.ts) |
| `thread_works` | `created_at` | [`../src/schema/agent-threads.ts`](../src/schema/agent-threads.ts) |

Everything else is Date mode. Treat new `mode: "string"` columns as a red flag —
they fork the mapping contract for adapters.

### Hard invariant: never bind a JS `Date` into a raw `sql` fragment

postgres-js rejects a raw `Date` embedded in a `` sql`...` `` template
(`ERR_INVALID_ARG_TYPE`). To compare against timestamp columns, use **typed
Drizzle comparators** or an **explicit `::timestamptz` cast** on a string param —
never a bare `Date` in a template. Canonical patterns:

- **Typed comparators** — `lt`/`eq`/`gt` encode the `Date` through the column
  type so postgres-js receives an ISO string:
  [`subscription-store.ts`](../../../apps/server/server/domains/billing/adapters/drizzle/subscription-store.ts)
  (`monotonicUpdateWhere`).
- **`::timestamptz` round-trip** — CAS revision tokens are read as `::text` and
  compared with `${revision}::timestamptz`, keeping microsecond precision:
  [`context-fs/drizzle-store.ts`](../../../apps/server/server/domains/context/adapters/context-fs/drizzle-store.ts)
  (`documentRevisionWhere` + the `updatedAt::text` selects).

## Migration workflow

Schema edits live in [`../src/schema/`](../src/schema). To ship a change:

1. `pnpm db:generate` — drizzle-kit appends the next migration to
   [`../src/migrations/`](../src/migrations).
2. **Review** the generated SQL before applying.
3. `pnpm db:migration-lint` — runs `tools/dev/migration-lint.ts --all`.
4. `pnpm db:migrate` — apply pending migrations.
5. If PL/pgSQL functions/triggers changed: update
   [`../src/functions/`](../src/functions) and run `pnpm db:apply-functions`
   (functions are applied separately, after migrate).

The journal is a squashed baseline (`0000_careless_rockslide`) plus additive
migrations (`0001_tidy_siren`, …); prefer additive migrations over re-squashing.

## Transaction model (lives in apps/server)

This package exposes no ambient transaction context. Cross-cutting transaction
propagation is owned by
[`apps/server/server/shared/drizzle-transaction.ts`](../../../apps/server/server/shared/drizzle-transaction.ts):
`runInDrizzleTransaction` opens one ambient `tx` via `AsyncLocalStorage`, and
adapters call `currentDrizzleDb(db)` on every query to join it. Adapters that
open their own `db.transaction()` without touching that store run in an
independent, non-nested scope.

## Rationale

The schema stays ordinary Postgres with no provider-specific auth coupling
(identity is app-owned `public.users` keyed by WorkOS `external_id`). The Date
vs string `mode` split is a known inconsistency, not a pattern to extend — see
the audit map at `work/v3-fullstack-rebuild/audit/db-orientation.md` in the docs
repo for the full column inventory and hazard list.
