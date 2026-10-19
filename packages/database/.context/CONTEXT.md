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
and `branch_commands` belong to the whole branch. The `branch_push_*` tables
retain their batch-level names. Migration `0068` renames metadata and replaces
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
mutation provenance sink are retired. Agent write receipts also hold nullable
`source_room`, `before_cut` and `after_cut` (Yjs snapshot V2 bytes), constrained
all-or-none. They are immutable historical cuts, not observation frontiers;
transport folding must not erase them or collect their source room's structs.

The change-trail signal triggers on `draft_write_journal`, `document_edits`
and `document_edit_parts` fire inside a writer keystroke's draft row lock,
three per key, so their cost is that writer's save latency and every other
writer's wait on the draft. `change_trail_owners` is defined only in migrations
(the current body is `0068_draft_branch_names.sql`, not `src/functions/`):
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
