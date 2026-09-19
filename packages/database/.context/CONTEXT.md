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

`document_yjs_heads.schema_version` and `document_branches.schema_version` store
the packed integer form of `COLLAB_SCHEMA_VERSION`
(`major * 1_000_000 + minor * 1_000 + patch`; `0.1.0` is `1000`). Their Drizzle
defaults call the shared packer; do not restore a second literal or
comment-maintained copy. The server's Drizzle adapters pack on write and unpack
on read so database integers never cross into domain or port contracts. A
schema-version bump still requires an additive migration that advances both
Postgres column defaults for deployed databases.

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

A row-transform migration MUST ship with a populated upgrade fixture in
`fresh-migrations.db.test.ts`. Apply the committed prefix, seed the pre-migration
shape, and prove the fixture fails before the transform (pre-fix red) and passes
after the remaining chain runs. Cull the fixture once the migration is
superseded and frozen: pre-launch schema freedom means old migration history is
not a live contract.

The journal is a squashed baseline (`0000_thankful_tarantula`) plus additive
migrations (`0001_serious_red_skull`, …); prefer additive migrations over
re-squashing.

### Merge renumbering

Never renumber a migration already present on `main`. When merging a branch
whose ordinals collide with newly deployed ones, renumber only the branch
migrations behind the deployed tail and regenerate their snapshots. The
journal tail must maintain strictly monotonic `when` timestamps; renumbering
ordinals without advancing timestamps can make an incremental database skip
the renumbered entries while a fresh database applies them normally. A
monotonic-order regression test (`fresh-migrations.db.test.ts`) covers the
changed tail after any renumber.

### Works columns that must not return

`works` lives in [`../src/schema/content.ts`](../src/schema/content.ts)
(`src/schema/works.ts` re-exports it). `visibility` and `persistence` were
speculative columns that no code read. They are dropped. If multi-writer
sharing or ephemeral-work GC returns, design fresh columns; do not resurrect
those shapes. Works are archived (visibility) or soft-deleted with a 30-day
window; nothing is discarded on a timer. No Work is a locked Work, not a
sharing preference.

## Focused DB test resets and semantic reads

Focused DB test resets treat requested tables as scope anchors, derive the
complete referencing-table closure from live `pg_catalog.pg_constraint`, lock
the closure in deterministic schema-qualified name order, and DELETE
child-first in one transaction. The anchor list is scope, not an exhaustive
delete order; a newly applied FK is included automatically. Reject missing
anchors and cross-table cycles. Self-referencing FKs do not affect ordering.
Broad suites may still `TRUNCATE ... CASCADE`; focused suites use catalog
DELETE so unrelated tables survive.

Do not hand-maintain child lists, defer constraints, or treat Drizzle metadata
as the live catalog.

History assertions and membership assertions are different reads. Raw SELECT
return order is never a history contract:

| Helper | Semantics |
|---|---|
| `trailEventSequence` | Outbox events ordered by trail, version, and event kind |
| `trailRowMembership` | Shell, detail, and outbox snapshots in deterministic identity order with no lifecycle meaning |

Do not sort assertion inputs after an unordered read.

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
vs string `mode` split is a known inconsistency, not a pattern to extend.

### Retained Agent definitions

`agent_package_revisions` retains complete source snapshots. Its coordinate/digest
key deduplicates installs. `agent_definition_revisions` retains one compiled Agent
per package revision and local slug. Catalog pointers and thread bindings use
revision FKs with restricted deletion; hiding a catalog entry preserves bound
content. Account deletion cascades catalog entries and threads, not source rows.

`agent_catalog_entries` has account-owned and system-owned logical-key indexes.
`agent_catalog_revisions` retains previously selected revision memberships; the
current catalog pointer grants current membership directly. Pointer CAS and
history insertion share one transaction. `thread_agent_bindings` has one row per thread. The server's Agent revision store
owns insert-only content, catalog compare-and-set selection, and idempotent fixed
binding. It joins the existing ambient transaction owner so thread admission can
include source, catalog, and binding writes atomically.

`agent_package_dependencies` retains manifest-name edges to exact package revisions with restricted dependency deletion. Source identity includes the dependency map. `thread_agent_bindings.configuration` stores the resolved model, skill-content identities and named-target revisions alongside the immutable definition reference. Idempotent binding compares both revision and configuration; it cannot change either.

Agent package installations retain account/system current and upstream source heads plus owned history. Definition content stays in immutable source revisions. Legacy project Agent/skill tables, the turn Agent-definition FK and the unused slug-default preference are absent; execution identity comes from the thread binding.

`project_agent_removals` is a Project/catalog-entry exclusion relation. Cascading
FKs clean up deleted Projects and catalog entries; publication and definition
revision changes preserve exclusions. It is not another definition owner.
