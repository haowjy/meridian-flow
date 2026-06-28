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
  type so postgres-js receives an ISO string. Use this for timestamp comparisons
  instead of embedding raw `Date` values in `sql` fragments.
- **`::timestamptz` round-trip** — CAS revision tokens are read as `::text` and
  compared with `${revision}::timestamptz`, keeping microsecond precision:
  [`context-fs/drizzle-store.ts`](../../../apps/server/server/domains/context/adapters/context-fs/drizzle-store.ts)
  (`documentRevisionWhere` + the `updatedAt::text` selects).

### Thread-domain rollup columns

The `threads`, `turns`, `model_responses`, and `turn_blocks` tables persist the
JSON-natural thread contract fields that repository conformance reads back:
thread total cost, turn usage rollups/latest model metadata, model-response
reasoning/cache token counts, and block provider metadata. These columns are
maintained by TypeScript repositories and the read-model projector; do not add
database triggers/functions for these rollups.

### Yjs document heads and checkpoints

`document_yjs_heads.latest_checkpoint_id` is declared in the Drizzle schema as an
FK to `document_yjs_checkpoints.id` with `ON DELETE SET NULL`. Checkpoints are
append-only in the production lifecycle: compaction deletes retained
`document_yjs_updates` rows, not checkpoint rows, and checkpoints are removed by
the `documents` cascade. Do not document this relationship as custom SQL or as an
absent FK.

### Billing storage

Billing has no `user_subscriptions` table in the current schema. Stripe customer
identity lives on nullable `users.stripe_customer_id`; subscription, free-tier,
and extra-usage entitlements are represented by `credit_lots` rows. Extra-usage
purchase lots do not require an active subscription. Free-tier grants are fenced
by the partial unique index `credit_lots_free_tier_grant` on `(user_id,
grant_reason)` for `source_type = 'grant'` and `grant_reason LIKE
'free_tier_%'`.

## Migration workflow

Schema edits live in [`../src/schema/`](../src/schema). To ship a change:

1. `pnpm db:generate` — drizzle-kit appends the next migration to
   [`../src/migrations/`](../src/migrations) and updates
   [`../src/migrations/meta/`](../src/migrations/meta).
2. **Review** the generated SQL and `meta/_journal.json`. Commit the new `.sql`,
   `_journal.json`, and `meta/*_snapshot.json`. Snapshot JSON is generated and
   diff-collapsed by `.gitattributes`, but it is required input to the next
   `db:generate`; deleting one can silently make drizzle-kit re-emit old tables.
3. `pnpm --filter @meridian/database exec drizzle-kit check` — verifies the
   journal/snapshot chain. CI always runs this as a blocking migration check.
4. `pnpm db:migration-lint` — runs `tools/dev/migration-lint.ts --all`.
   Errors always block. Warnings block only under `--strict`, which CI uses for
   PRs targeting `main`/`staging`; feature-branch PRs lint only migrations changed
   since the base ref. The squashed `0000_` baseline is exempt from warning rules
   except `DELETE_WITHOUT_WHERE`.
5. `pnpm db:migrate` — apply pending migrations.
6. If PL/pgSQL functions/triggers changed: update
   [`../src/functions/`](../src/functions) and run `pnpm db:apply-functions`
   (functions are applied separately, after migrate).

The journal is a squashed baseline (`0000_thankful_tarantula`) plus additive
migrations (`0001_serious_red_skull`, …); prefer additive migrations over
re-squashing.

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
the [schema map](schema-map.md) for the full column inventory and hazard list.

## Schema map (regenerate-on-demand)

A durable orientation map of the whole DB layer lives next to this file:

- [`schema-map.md`](schema-map.md) — package layout, per-table column inventory,
  relationships, and the timestamp-mode / `Date`-binding hazard list.
- [`schema-map/index.html`](schema-map/index.html) — interactive ER view (open in
  a browser; click any table for its purpose, columns, and source links).

It is **regenerated on demand, not auto-maintained**. Each map records when it was
last regenerated vs. when the DB layer source last changed
(`git log -1 --date=short --format=%cd -- packages/database/src`). If the source
is newer than the regen date, treat the map as stale and rebuild it from the
current `src/schema/*.ts` definitions.
