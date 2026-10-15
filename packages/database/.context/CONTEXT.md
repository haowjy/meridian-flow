# @meridian/database — Postgres contract

This page covers the database contracts that cross the schema, migration
runner, and server adapters. Generated schema and SQL are authoritative for
field shape; keep this page for invariants and migration safety.

## Migration integrity

A merged migration is immutable because already-applied databases cannot see an
in-place correction. Repair incompatible rows forward in a later migration,
scoped to the rows the gap produced, before the statement that needs clean data.
Never hand-patch an applied migration ledger or reset another checkout's
database.

Write every migration as if tables contain writer data: move rather than delete
it, and never justify a lint skip with empty tables. Add CHECKs and FKs as `NOT
VALID`, validate separately, and build or drop indexes `CONCURRENTLY`. A
no-transaction file starts with its marker, isolates each concurrent statement
in its own breakpoint, and makes every statement re-runnable. The runner drops
only INVALID remnants named by concurrent builds; it never drops a valid index.
`lock_timeout` brackets only statements that need an ACCESS EXCLUSIVE lock.

The runner holds one session advisory lock for the run. Ordinary migrations
commit their history row with the file; no-transaction files record history
only after every statement succeeds. It validates journal identity and applied
hashes before work. Regeneration after a base merge discards hand edits, so
reapply online-safety changes and review the resulting SQL.

When two lanes add a migration at the same ordinal, regenerate the unmerged
lane's generated migration from the merged schema (`src/schema/` holding both
sides); never renumber, rename, or hand-edit its identity. Two lanes that each
recreate the same CHECK list only their own value, so a hand renumber silently
drops the other lane's value, breaks the snapshot `prevId` chain, and can make
an incremental database skip an entry a fresh one applies. A second
`db:generate` must report no changes. A handwritten `--custom` migration cannot
be regenerated: recreate it at the new ordinal and copy the body. Read the
target's highest ordinal from its journal. A lane database that applied the
replaced identity needs an owner-authorized reset of that checkout only.

Schema workflow is `db:generate`, review SQL/journal/snapshots, `drizzle-kit
check`, migration lint, then `db:migrate`. Function files are synchronized after
migrations. A row-transform migration needs a populated upgrade fixture; the
fixture can be retired only after a later frozen migration supersedes it.

### Data steps and the diff-based review upgrade

Some upgrades need code between two SQL migrations. A data step is
`{ id, version, preflight, run }` in the registry
([`tools/dev/lib/migration-data-steps.ts`](../../../tools/dev/lib/migration-data-steps.ts));
its implementation in [`../src/migration-steps/`](../src/migration-steps) uses the
release's own code (the review-base conversion calls `@meridian/agent-edit/diff`),
so no frozen copy exists.

- The migration the step must precede carries `-- data-step: <id>@<version>` on
  its first line; the registry is keyed by `id@version`, so a renumber changes
  nothing. The runner refuses a pending migration whose marker names an
  unregistered step or version, and a step marked more than once.
- Under the migration advisory lock, `preflight` runs read-only before the run's
  first pending migration, so a refusal leaves the database as the previous
  release left it; `run` runs immediately before its anchor. Steps are
  restartable. Failures name ids, never prose.

One `pnpm db:migrate` upgrades a database that ran the old review model, in
steps that are each online-safe: `0050` and `0051` add `base_revision`,
`apply_payload` and the content-Apply trail arm; `0052` and `0053` drop the
`document_edits` action index and columns (the index concurrently, in its own
no-transaction file); `0054` rewrites `document_edit_parts` in committed batches
with `jit = off` and swaps the check and indexes without a window lacking one;
`0055` is the anchor (`-- data-step: review-base-conversion@1`) and the only file
that destroys data, so it begins with `DO` guards and drops the generation
columns and `live_cut`.

The `review-base-conversion@1` step converts every active `work_draft` branch
with a NULL `base_revision`: the base is the `live_cut` text, or the branch's own
text when it has no journal rows (a branch with journal rows and no cut stops the
run with its ids). Each row is one compare-and-swap on its prior `state`; it
writes `review_base`, recomputes `has_effect`, and sets `base_revision` to the
initialized-unknown sentinel so the first rebase merges live's edits since. Its
preflight refuses with batch ids if any settlement batch is `pending` or
`blocked`: let the old release's recovery drain them, stop it, then run
`db:migrate`. Servers stop before `db:migrate` and start after it. The
populated-upgrade proof is
[`docs/qa/review-base-upgrade.md`](../../../docs/qa/review-base-upgrade.md).
`draft_commands` rows are not migrated, and the unwritten
`branch_write_journal` and `push_lineage.journal_ids` columns stay for history.

## Schema contracts

Drizzle timestamp helpers use JS `Date` mode. The small set of string-mode
columns is deliberate; do not extend it casually. Never bind a JS `Date` inside
a raw `sql` fragment: use a typed comparator or an explicit timestamptz cast.

Thread rollups are written by TypeScript repositories and the read-model
projector, never triggers. The thread activity projection
(`last_activity_at`, `conversational_leaf_turn_id`) is the deliberate
trigger-owned exception, because any future writer that moves
`active_leaf_turn_id` must not be able to leave it stale. JSON CHECKs use
`IS TRUE` so absent and JSON-null values do not pass by SQL's three-valued
logic. `turns.origin` has no column default: every insert states it.

`thread_execution_reports` holds one immutable terminal result per admitted
child execution, not a latest-result slot. A composite child-thread/turn FK
keeps a report on its own thread's turn; caller references use `SET NULL` so
deleting an invocation never erases the child's output. Payload presence is
preserved (`NULL` differs from JSON `null`): read `payload::text` and parse it
once, since the driver-decoded JSONB string plus Drizzle's second parse turns
JSON-looking scalar strings into other values.

Forward-turn inverses and write provenance live in immutable `document_edits`
and `document_edit_parts`; the legacy reconstruction tables and the unused
mutation provenance sink are retired.

Works retire by archive or by soft delete with a 30-day restore window; the
hourly purge job disposes of expired Works. `deleted_by_work_id` markers on
owned rows identify exactly what a restore revives; their FKs are `ON DELETE
SET NULL` so a stale marker never deletes, and purge deletes marked rows
explicitly. Draft branches carry no marker: soft delete leaves drafts alone and
purge disposes of them. The dropped `works.visibility` and `persistence` were
speculative and must not return; if multi-writer sharing or ephemeral-Work GC
comes back, design new columns. No Work is a locked Work, not a sharing
preference.

`document_yjs_heads.latest_checkpoint_id` is a Drizzle FK with `ON DELETE SET
NULL`. Compaction retires update prefixes through the generation-local
`retired_through_seq`; checkpoints survive until document cascade except for
the initial seed. Lazy checkpoint cuts validate their captured suffix floor
against `retired_through_seq` after fetching inputs and again under the
persistence lock; generation replacement resets it. Schema versions are packed
only inside Drizzle adapters and must use the shared packer (no second literal);
a `COLLAB_SCHEMA_VERSION` bump still needs an additive migration advancing both
Postgres column defaults. The checkpoint range capture function stays one SQL
statement: a client-managed savepoint spanning awaits can roll back sibling
operations queued on the same connection.

Billing stores Stripe customer identity on `users.stripe_customer_id`; credit
lots represent grants and purchases. The partial free-tier uniqueness guard
prevents duplicate grants without requiring a subscription table.

## Boundaries and tests

This package exposes no ambient transaction context. Server adapters join the
server-owned transaction store; a fresh `db.transaction()` is an independent
scope.

Focused database resets derive the complete FK closure from `pg_catalog`, lock it
in deterministic order, and delete child-first in one transaction. History
sequence assertions and membership assertions have different ordering
semantics; raw SELECT order is never a lifecycle contract.

Prompt bakes are insert-only and their pointers are write-once; a rebake inserts
a new row (only the runtime's `beginPromptEpoch` does, for compaction), and a
thread is never repointed to change what its requests send. Pending
placeholder predicates derive from the contracts role set, so adding a role also
requires regenerating the partial index. Agent source and definition revisions
are immutable and held by restricted-deletion FKs, so hiding a catalog entry
preserves bound content and account deletion cascades catalog entries and
threads, not source rows. Catalog selection and the one-per-thread binding use
compare-and-set and join the ambient transaction; idempotent binding compares
revision and configuration and changes neither. The binding's configuration
holds the resolved model, skill-content identities, and named-target revisions;
execution identity comes from the thread binding, and the legacy project
Agent/skill tables, the turn Agent-definition FK, and the slug-default
preference are gone. `project_agent_removals` is only
a Project/catalog-entry exclusion, never another definition owner.
