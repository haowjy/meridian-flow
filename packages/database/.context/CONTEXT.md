# @meridian/database — Postgres contract

This page covers the database contracts that cross the schema, migration
runner, and server adapters. Generated schema and SQL are authoritative for
field shape; keep this page for invariants and migration safety.

## Baseline inputs

Before the first deploy with retained data, `db:generate` creates one baseline.
The generator combines extension setup, Drizzle's schema DDL, `src/functions/*.sql`
and `src/schema/sql/baseline.sql`, in that order. The last file owns the triggers,
deferrable foreign keys and storage settings Drizzle cannot express. There is no
separate function-sync path: the SQL hash covers all of them.

The runner snapshots the baseline before waiting on its session advisory lock,
then applies all SQL and its ledger row in one transaction. Repeating the same
baseline is a no-op. Any other installed hash or multiple ledger rows refuses
and directs local developers to reset their own database. It never upgrades or
resets a deployed database. Dev startup checks the same identity.

Generated metadata uses a fixed timestamp and snapshot UUID so schema-equivalent
branches regenerate byte-identical output. Resolve schema conflicts first and
regenerate the three migration artifacts; never merge their SQL by hand.

## Schema contracts

A document tombstone has a non-null deletion reason exactly when it has
`deleted_at`. User, Work and system-cause fields identify its actor; legacy
actors may be unknown. Only a Work cascade sets `deleted_by_work_id`, which
remains its restore marker. Restore clears all removal fields. A closed draft
has its own `closed_cause`, independent of the document's current removal
(`discarded` or `document_removed`), so Work restore does not erase why a
draft closed. `content_purged_at` marks a tombstone whose document bytes and content history have
been released after the retention window; placement and the removal record remain.

A `branches` row is one owner's pending file tree. Its active owner is either
a Work (`origin_work_id`) or a conversation lineage (`origin_root_thread_id`,
no foreign key), enforced by `branches_one_owner`.
`branches.pending_document_count` is its own count;
`works.pending_document_count` sums its active branches.
`document_drafts` stores document versions, with writes in
`draft_write_journal`; `branch_tree_changes` belongs to the whole branch. `document_commands` holds one row
per command sent as a request (Apply, Un-Apply, Discard), inserted first in the effect
transaction with its final outcome.

A stored object (`documents.storage_url`) requires a MIME type. Text documents
need neither column; purge clears both. Export chooses the output format rather
than treating a missing stored MIME type as an imported binary's type.

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

Undo records an inverse as a new edit rather than rewriting history. Immutable
`document_edits` and `document_edit_parts` retain the original edit, its author
and the inverse needed to take it back.

Works retire by archive or by soft delete with a 30-day restore window; the
hourly purge job disposes of expired Works. `deleted_by_work_id` markers on
owned rows identify exactly what a restore revives; their FKs are `ON DELETE
SET NULL` so a stale marker never deletes, and purge deletes marked rows
explicitly. Branches and their drafts carry no marker: soft delete leaves them alone and
purge disposes of them. Each project has a locked Work row for the UI's
“None” selection; it cannot be archived or deleted.

`document_yjs_heads` is the identity of a Yjs document, of one `kind`: its journal rows
(`document_yjs_updates`, `document_yjs_checkpoints`) cascade from it, not from `documents`, so
a document's text can exist before its `documents` row (an import). A `document` head's id is
a `documents.id`; the `documents_delete_yjs_head` trigger deletes it with the document, and
`initializeHead` refuses an existing head of another kind. A `tree_list` head is a project's
or an account's tree list: its id is the owner's `tree_list_id`, a column of its own made with
the owner, and the `projects_` / `users_create_tree_list_head` triggers make the head in the
same statement. `project_id` / `user_id` name the owner, whose delete takes the head, and a
list is written with no document. So no document's or node's id is ever a list's.
`latest_checkpoint_id` has no FK: checkpoints reference their head, and a cycle gives the
focused resets no delete order.
`tree_node_ids` holds the claim on every node id any list has made: its primary key is the
claim, taken by one insert in the admitting transaction, and `tree_nodes` / `branch_tree_nodes`
reference `(id, list_id)` in it, so a row cannot be written for another list's id. They are the
project tree's rows, written only by the tree list store (domains/context). Compaction retires update prefixes through the generation-local
`retired_through_seq`; checkpoints survive until document cascade except for
the initial seed. Lazy checkpoint cuts validate their captured suffix floor
against `retired_through_seq` after fetching inputs and again under the
persistence lock; generation replacement resets it. Schema versions are packed
only inside Drizzle adapters and must use the shared packer (no second literal);
a `COLLAB_SCHEMA_VERSION` bump updates both Postgres column defaults and regenerates
the baseline. The checkpoint range capture function stays one SQL
statement: a client-managed savepoint spanning awaits can roll back sibling
operations queued on the same connection.

`observation_frontiers` and `thread_shown_links` are collab's tables (what the model was shown
of documents). A frontier is keyed by the transcript block that showed the model a document
(`source_block_id`, no foreign key, so a fork finds inherited rows by block id with nothing
copied and a row left behind by a crash is never read). Its `project_id` cascades with the
project, and its plain `thread_id` is what `forgetThreads` deletes by when a thread is deleted;
`thread_shown_links` has the same two columns. The model's frontier for a room is the row with
the greatest `recorded_seq` among the block ids a lookup names, read through the
`(room_key, recorded_seq DESC NULLS LAST)` index
([runtime document text](../../../apps/server/server/domains/runtime/.context/document-text.md#observation-frontiers)).

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
`fixture+<suite>@test.invalid` email. A test that seeded the dev auth
bypass email (`<DEV_AUTH_USER_ID>@example.com`) would overwrite the dev user's row.

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
execution identity comes from the thread binding. `project_agent_removals` is only
a Project/catalog-entry exclusion, never another definition owner.
