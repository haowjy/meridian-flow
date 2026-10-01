# @meridian/database — Postgres Contract

This package owns the Postgres contract: Drizzle schema, generated migrations,
PL/pgSQL functions, and the `createDb(DATABASE_URL)` factory. It has **no**
business logic and **no** ambient transaction context — domain persistence and
transaction propagation live in `apps/server`.

## Migration integrity

A migration merged to `main` or `staging` is frozen ([`../AGENTS.md`](../AGENTS.md)).
When one leaves data that a later change cannot accept, a later migration
repairs it forward, scoped to the rows the gap produced and placed before the
statement that needs clean data. Any unrelated violation must still fail.
The frozen file is never corrected in place, because databases that already
ran it would never see the correction.

`0014_threads_origin_turn_fk` is the example. `0009_repair_saved_subagent_contracts`
deletes unrepairable subagent notices without updating `threads.origin_turn_id`
or a cross-thread `turns.parent_turn_id`, so `0014`'s `lineage-repair` block
runs before the origin foreign key, in this order:

1. Snapshot forks and handoffs whose origin turn is gone, with their old
   `spawn_depth`.
2. Re-root each one's reachable subtree (spawn children by `parent_thread_id`,
   derivations by the owner of their origin turn): `root_thread_id` becomes the
   nearest broken ancestor, `spawn_depth` shifts down by its old depth, and a
   derivation sibling's `parent_thread_id` is cleared.
3. Null dangling `parent_turn_id`s inside the broken threads only.
4. Demote the broken threads to organic roots.

Demotion erases the dangling origin and the old depth, so it runs last.
Re-rooting the whole subtree preserves the threads domain's one-root lineage
contract ([threads context](../../../apps/server/server/domains/threads/.context/CONTEXT.md)).
Never hand-patch an applied database's migration ledger or reset a shared
database. Rationale and rejected repairs: [Drizzle Migration Integrity][kb-migration-integrity].

[kb-migration-integrity]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/platform/stack/drizzle-migration-integrity.md

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

### Thread inbox kinds

Inbox provenance and body kinds live only in their JSON values. CHECK constraints
use `IS TRUE` so absent, JSON-null and invalid kinds are rejected rather than
passing SQL CHECK's three-valued logic.

### Thread-domain execution reports

`thread_execution_reports` stores one immutable terminal result per admitted
child execution, not a mutable latest-result slot. `execution_turn_id` is the
first turn the run reserved, which may be a pending compaction rather than an
assistant turn; `terminal_turn_id` is the turn the run ended on. The composite
child-thread/turn foreign key prevents assigning a report to a turn owned by
another thread. Child/turn ownership cascades; nullable
caller thread/turn/card references use `SET NULL` so deleting the invocation
does not erase the child's output. Soft deletion is enforced by live
repository reads, not destructive report mutation. The initial table has no
backfill or compatibility path.

The public `payload` is an exact optional `JsonValue`: omitted content is SQL
`NULL`, while JSON `null` remains a present value. The Drizzle report adapter
reads `payload::text` and parses that database representation once; do not use
the driver-decoded JSONB string with Drizzle's second JSON parse, which changes
JSON-looking scalar strings into their parsed values. The capture codec also uses
`::text`: SQL NULL is absent, while every present JSON value must validate as a
ReturnResultCapture object (including rejecting JSON null).

### Thread-domain rollup columns

The `threads`, `turns`, `model_responses`, and `turn_blocks` tables persist the
JSON-natural thread contract fields that repository conformance reads back:
thread total cost, turn usage rollups/latest model metadata, model-response
reasoning/cache token counts, observed reset, predicted cache state/reason,
successful-attempt start and latency/TTFT/generation timing, and block provider
metadata. These values are written by TypeScript repositories and the
read-model projector; do not add database triggers/functions for them.

The one deliberate exception is `threads.last_activity_at` and
`threads.conversational_leaf_turn_id`: unlike the rollups above, which have
exactly one writer (the read-model projector), any future writer that moves
`threads.active_leaf_turn_id` (branch switching, for example) must not be able
to leave this projection stale, so Postgres triggers own it instead. See
[`domains/threads/.context/CONTEXT.md`](../../../apps/server/server/domains/threads/.context/CONTEXT.md#chat-activity-projection-single-owner)
and migration `0000_baseline.sql` (the `recompute_thread_chat_activity` function and its triggers).

`turns.origin` (`text NOT NULL`, `turns_origin_valid` check, migration
`0005_turn_origin.sql`) has no column default: every insert states it, so a
caller that forgets fails loudly rather than silently defaulting. An existing
dev database backfills it from `role` (`assistant` → `assistant`, `user` →
`writer`, else `system`) in the same migration, before the column is locked
to `NOT NULL`. See
[`domains/threads/.context/CONTEXT.md`](../../../apps/server/server/domains/threads/.context/CONTEXT.md#turn-authorship-turnsorigin)
for what it means and its current (logging-only) scope.

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
   since the base ref. The squashed `0000_` baseline is exempt from all lint rules
   except `DELETE_WITHOUT_WHERE`.
5. `pnpm db:migrate` — apply pending migrations, then synchronize the PL/pgSQL
   functions in [`../src/functions/`](../src/functions). Use
   `pnpm db:apply-functions` only when the guarded standalone function sync is
   needed.

Deploy uses the database-owned release runner. `tools/deploy/deploy.ts` first
creates and confirms the provider snapshot, then supplies
`MERIDIAN_BACKUP_REF=<provider>:<backup id>:release=<sha>` with the new image.
When migrations are pending, the release runner requires that ref to match
`MERIDIAN_RELEASE_SHA`, rejects inconsistent or divergent migration history,
and applies pending migrations plus canonical functions in one transaction.
A database whose applied history extends the release journal's exact prefix is
a valid rollback target with zero pending migrations; functions are not
re-applied from an older image. Server `/readyz` rejects a behind or divergent
schema while allowing a matching database that is ahead.

A row-transform migration MUST ship with a populated upgrade fixture in
`fresh-migrations.db.test.ts`. Apply the committed prefix, seed the pre-migration
shape, and prove the fixture fails before the transform (pre-fix red) and passes
after the remaining chain runs. The upgrade fixture may be culled once a later
frozen migration supersedes the transform. The original migration file itself
stays frozen once merged, as required by [`../AGENTS.md`](../AGENTS.md).

The journal starts at `0000_baseline`; future schema changes append migrations.
Existing databases that ran the pre-relaunch chain must be reset with
`pnpm db:reset` (local data is destroyed), not incrementally migrated.

The baseline includes `pg_trgm`, all Drizzle-declared CHECKs, and the two
change-trail lifecycle functions/triggers on `branch_write_journal`. The three
functions in `src/functions/` remain a separate post-migration install that the
`db:migrate` runner synchronizes. Fresh installs seed no users, Projects, or
Works: the historical No Work and thread binding backfills had no rows to
transform. Application project bootstrap creates locked No Work; thread
admission establishes the primary binding. Legacy user imports belong in a
separate ETL, not universal schema migrations.

### Merging parallel migration lanes

For generated migrations, when two branches add at the same ordinal, **regenerate the
incoming branch's migration from the merged schema; never renumber, rename, or
hand-edit it.** Never touch a migration already present on the target branch
(or on `main`).

1. Keep the target branch's migrations, snapshots, and journal entries as
   they are.
2. Delete the incoming branch's colliding `.sql`, its `meta/NNNN_snapshot.json`,
   and its `_journal.json` entry.
3. Resolve `src/schema/` so it holds both sides. A constraint or enum both
   branches rewrote must carry the union of their values.
4. Run `pnpm db:generate`. It emits one migration chained on the target's last
   snapshot, with a fresh `when` timestamp. Review the SQL against the deleted
   file, then run `pnpm db:generate` again: it must report no changes.
   `git add` the new `.sql` and snapshot explicitly; the merged journal already
   names them.
5. A handwritten `--custom` migration cannot be regenerated. Recreate it with
   `drizzle-kit generate --custom` at the new ordinal and copy its body.

Why: two lanes that each recreate the same CHECK constraint can each list only
their own value. Renumbering one by hand keeps that SQL, so whichever runs last
silently drops the other lane's value. A renamed file also breaks the snapshot
`prevId` chain, and ordinals without advancing
`when` timestamps can make an incremental database skip entries that a fresh
database applies. `fresh-migrations.db.test.ts` checks strict journal ordering
and the installed baseline hash without preventing future additive migrations.

### Works columns that must not return

`works` lives in [`../src/schema/content.ts`](../src/schema/content.ts)
(`src/schema/works.ts` re-exports it). `visibility` and `persistence` were
speculative columns that no code read. They are dropped. If multi-writer
sharing or ephemeral-work GC returns, design fresh columns; do not resurrect
those shapes. Works are archived (visibility) or soft-deleted with a
30-day restore window; expired Works are permanently purged by the hourly
`work-purge` recovery job. `deleted_by_work_id` markers on owned rows identify
the exact set restored during that window. Their FKs are `ON DELETE SET NULL`,
so deleting a Work never deletes through a stale marker; the purge deletes
marked rows explicitly. No Work is a locked Work, not a sharing preference.

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

### Prompt bakes

`prompt_bakes` rows are insert-only: the `prompt_bakes_insert_only` trigger
rejects updates and direct deletes (a cascade from deleting the owner thread
is allowed). `threads.initial_prompt_bake_id` and
`turns.prompt_bake_id` are write-once pointers. A rebake inserts a new row and
points a completed boundary turn at it; the runtime's `beginPromptEpoch` is the
only operation that does so, and compaction is its caller. Never update a bake
row or repoint a thread to change what a thread's requests send.

### Pending placeholders

A pending placeholder is a `turns` row with status `pending` and a role in
`PENDING_PLACEHOLDER_ROLES` from `@meridian/contracts/threads` (today only
`compaction`). [`pending-placeholder.ts`](../src/schema/pending-placeholder.ts)
builds the SQL twin of that predicate from the contracts set, and the
`turns_pending_placeholders` partial index uses it. The generated index SQL
inlines the role list, so adding a placeholder role requires `pnpm
db:generate` to rebuild the index. A pending compaction has no
`compaction_model`; `turns_compaction_model_required` requires one only once it
is complete.

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
