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
`lock_timeout` brackets statements that need an ACCESS EXCLUSIVE lock, and each page of a no-transaction backfill (0083) so a row or counter wait fails fast instead of queueing.

A no-transaction SQL file may declare a colocated TypeScript companion with
`-- migration: code <file>.ts sha256:<digest>`. History validation checks its
bytes against the SQL's frozen digest, and the runner awaits its `migrate(session)`
before SQL assertions and the ledger write. The companion owns bounded transactions
on the same reserved session. Every deploy path uses this runner, not Drizzle's
SQL-only migrator. Runtime kernel imports remain outside `tools/dev`. Conversion-only kernel helpers
and the Apply-record encoding used by 0078 are part of its frozen contract; keep
those semantics stable until a new baseline retires that migration.

The runner holds one session advisory lock for the run. Ordinary migrations
commit their history row with the file; no-transaction files record history
only after every statement succeeds. It validates journal identity and applied
hashes before work. Regeneration after a base merge discards hand edits, so
reapply online-safety changes and review the resulting SQL.

When two branches add a migration at the same ordinal, regenerate the unmerged
branch's generated migration from the merged schema (`src/schema/` holding both
sides); never renumber, rename, or hand-edit its identity. Two branches that each
recreate the same CHECK list only their own value, so a hand renumber silently
drops the other branch's value, breaks the snapshot `prevId` chain, and can make
an incremental database skip an entry a fresh one applies. A second
`db:generate` must report no changes. A handwritten `--custom` migration cannot
be regenerated: recreate it at the new ordinal and copy the body. Read the
target's highest ordinal from its journal. A worktree database that applied the
replaced identity needs a reset of that checkout's database only.

Schema workflow is `db:generate`, review SQL/journal/snapshots, `drizzle-kit
check`, migration lint, then `db:migrate`. The frozen journal's idx values and
numeric filename prefixes differ. Generate with `--prefix=timestamp` to avoid
Drizzle's default index prefix overwriting an older snapshot, then name only the
new, never-applied SQL/snapshot at the next free numeric ordinal and update that
new journal tag. Keep generated snapshot UUIDs/prevId unchanged; a second
generation must report no changes. Function files are synchronized after
migrations. A row-transform migration needs a populated upgrade fixture; the
fixture can be retired only after a later frozen migration supersedes it.

## Schema contracts

A document tombstone has a non-null deletion reason exactly when it has
`deleted_at`. User, Work and system-cause fields identify its actor; legacy
actors may be unknown. Only a Work cascade sets `deleted_by_work_id`, which
remains its restore marker. Restore clears all removal fields. A closed draft
has its own `closed_cause`, independent of the document's current removal
(`discarded` or `document_removed`), so Work restore does not erase why a
draft closed. Migrations 0072–0074 add the record, backfill in bounded,
re-runnable no-transaction pages, retire existing tombstones' active drafts
and tree uses, then validate. The pending-part pass is independently paged;
an interrupted cutover must finish before serving traffic.


A `branches` row is a Work's pending file tree. `document_drafts` stores each
document version, with writes in `draft_write_journal`; `branch_tree_changes`
and `branch_commands` belong to the whole branch. Expand-only migrations 0075
(server journal source and Apply-click command kind) and 0076 (replacement trail
functions) precede preflight and write no data. Migration 0077 refuses legacy
NULL cuts and unfinished Apply. Repair missing legacy cuts and complete or
withdraw every staged Apply using the installed release before stopping it;
preflight refuses to proceed while either invariant is unmet. 0078 folds retained Work drafts and records
every generation's applied ranges in their Yjs Apply root. It clears active cuts
under row locks; exact closed-row entries make restart and parallel conversion
idempotent. Released content stays released. 0079 builds replacement indexes and
pages value cleanup; 0080 retires placement, draft generations and settlement tables;
0081 validates journal status. No server starts partway through this cutover.

Owner handles expand in metadata-only 0082, then backfill in no-transaction
0083 with 500-row commits and a temporary concurrent seek index. A cutover-only
trigger allocates missing Work handles from the same atomic project counter as
application creation, including concurrent inserts and soft-deleted Works; No
Work stays null. Restart skips assigned handles and never lowers copied thread
counters. Constraint validation and concurrent index work happen outside DDL
transactions. The final short transaction removes the trigger and retired
columns/tables; it does no population-dependent work. "Online" here means bounded
transactions and concurrent index builds, not old and new releases serving
together: stop every application server and worker, old and new, before 0082 and
start only the new release after 0083 completes. The thread-handle counter moves
from `project_thread_counters` to `project_handle_counters` once per project, so a
chat created by either release mid-cutover leaves the new counter behind, and the
next chat in that project fails on `threads_project_ref`. Retry a failed 0083 with
writers still stopped; never restart the old release on a partly converted schema.
The old release also still reads `works.slug`, which 0083 drops.

`0092` rebuilds what an active branch's drafted tree entries own
(`branch_tree_folders`, `branch_tree_unsettled`, which 0090 and 0091 started
from current rows only) from `document_edits.tree_change`: the branch's rows on a
document after its latest settlement there, holding every folder they moved it
into and marking it unsettled unless each was rolled back. It is one read of the
history and inserts only into the two tables, so a rerun adds nothing. A release
before 0090 writes tree entries without that ownership, so stop every writer from
before 0090 until 0092 completes.

Migration `0068` renames metadata and replaces
both trail functions atomically. `0069` preserves opaque document-draft IDs and
rewrites JSON in native-primary-key pages of at most 500 rows, committing each
receipt's origin/placement and each settlement's payload/tag together. Link views
and their tuple digests change together (equivalent showings retain the greatest
sequence), then the pending-placement index is replaced concurrently. Command
fingerprints retain their original canonical key/kind encoding in
`collab/domain/branch-commands.ts`; stored hashes alone cannot be translated after
an API vocabulary change.


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

The change-trail signal triggers on `draft_write_journal`, `document_edits`
and `document_edit_parts` fire inside a writer keystroke's draft row lock,
one signal-trigger path per inserted row in those tables, so their cost is that writer's save latency and every other
writer's wait on the draft. `change_trail_owners` is defined only in migrations
(the current body is `0076_atomic_apply_trail.sql`, not `src/functions/`):
a replacement keeps `SET jit = off` (its recursive CTE's unbounded estimate
otherwise makes PostgreSQL compile LLVM code on every call, 15 ms empty and
hundreds once the tables grow), its primary-key journal lookup and its early
returns for inserts that have no owners. Measure an append's `holdMs` before
and after any change to these triggers.

Works retire by archive or by soft delete with a 30-day restore window; the
hourly purge job disposes of expired Works. `deleted_by_work_id` markers on
owned rows identify exactly what a restore revives; their FKs are `ON DELETE
SET NULL` so a stale marker never deletes, and purge deletes marked rows
explicitly. Branches and their drafts carry no marker: soft delete leaves them alone and
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

`observation_frontiers` rows belong to the transcript block that showed the
model a document (`source_block_id`, cascading with the block, so a fork finds
inherited rows by block id with nothing copied). The model's frontier for a room
is the row with the greatest `recorded_seq` among a conversation's blocks, read
through the `(room_key, recorded_seq DESC NULLS LAST)` index; the runtime owns when rows are
written and replaced ([runtime document text](../../../apps/server/server/domains/runtime/.context/document-text.md#observation-frontiers)).

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

DB tests seed `public.users` only through the shared fixture helper
(`src/__test-support__/db-fixtures.ts`), which gives each suite its own
`fixture+<suite>@test.invalid` email. A test that seeded the dev-login email
would overwrite the real WorkOS user and break dev login.

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
