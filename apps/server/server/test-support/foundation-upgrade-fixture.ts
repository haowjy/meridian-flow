/**
 * The Work-branch foundation's populated fixture: rows in `main`'s 0036 shape that 0037 to 0047 reshape, shared by
 * the foundation upgrade test and the review-base upgrade proof.
 */
import type postgres from "postgres";

export const id = (n: number) => `73600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SCOPE_KEY = `project:${id(2)}`;

/** Rows in `main`'s 0036 shape (prose stored as `.md`): every kind of row the foundation migration moves. */
export async function seedMainShape(sql: postgres.Sql) {
  const bytes = Buffer.from([0, 0]);
  await sql`INSERT INTO users (id, external_id, email) VALUES (${id(1)}, 'foundation-upgrade', 'foundation@example.test')`;
  await sql`INSERT INTO projects (id, user_id, name, slug) VALUES (${id(2)}, ${id(1)}, 'Upgrade', 'upgrade')`;
  // Work 3 drafts; Work 4 was deleted with its draft branch closed; Work 5 never drafted.
  await sql`INSERT INTO works (id, project_id, created_by_user_id, name, slug, deleted_at) VALUES
    (${id(3)}, ${id(2)}, ${id(1)}, 'Drafting', 'drafting', NULL),
    (${id(4)}, ${id(2)}, ${id(1)}, 'Deleted', 'deleted', '2026-09-01T00:00:00Z'),
    (${id(5)}, ${id(2)}, ${id(1)}, 'Idle', 'idle', NULL)`;
  await sql`INSERT INTO context_sources (id, project_id, name, slug) VALUES (${id(6)}, ${id(2)}, 'Manuscript', 'manuscript')`;
  await sql`INSERT INTO documents (id, context_source_id, name, kind, markdown_projection, updated_at, deleted_at) VALUES
    (${id(10)}, ${id(6)}, 'live', 'content', 'Live projection', '2026-09-01T01:00:00Z', NULL),
    (${id(11)}, ${id(6)}, 'trashed', 'content', 'Trashed projection', '2026-09-02T01:00:00Z', '2026-09-03T01:00:00Z'),
    (${id(12)}, ${id(6)}, 'second', 'content', 'Second projection', '2026-09-04T01:00:00Z', NULL),
    (${id(13)}, ${id(6)}, 'manifest', 'manifest', 'Manifest projection', '2026-09-05T01:00:00Z', NULL)`;

  await sql`INSERT INTO threads (id, project_id, root_thread_id, created_by_user_id, ref) VALUES
    (${id(20)}, ${id(2)}, ${id(20)}, ${id(1)}, 'c1')`;
  await sql`INSERT INTO document_branches (id, document_id, kind, upstream_branch_id, work_id, deleted_by_work_id, thread_id, status, state, state_vector) VALUES
    ('draft-live', ${id(10)}, 'work_draft', NULL, ${id(3)}, NULL, NULL, 'active', ${bytes}, ${bytes}),
    ('draft-closed', ${id(12)}, 'work_draft', NULL, ${id(3)}, NULL, NULL, 'closed', ${bytes}, ${bytes}),
    ('peer', ${id(10)}, 'thread_peer', 'draft-live', NULL, NULL, ${id(20)}, 'active', ${bytes}, ${bytes}),
    ('draft-deleted-work', ${id(10)}, 'work_draft', NULL, ${id(4)}, ${id(4)}, NULL, 'closed', ${bytes}, ${bytes}),
    ('orphan-peer', ${id(12)}, 'thread_peer', NULL, NULL, NULL, ${id(20)}, 'active', ${bytes}, ${bytes}),
    ('manifest-draft', ${id(13)}, 'work_draft', NULL, ${id(3)}, NULL, NULL, 'active', ${bytes}, ${bytes})`;
  for (let n = 1; n <= 4; n++) {
    const state = n === 3 ? "blocked" : n === 4 ? "completed" : "pending";
    const claimed = n === 2;
    await sql`INSERT INTO push_lineage (id, branch_generation, document_id, journal_ids, idempotency_key)
      VALUES (${n}, 1, ${id(10)}, '{}', ${`push-${n}`})`;
    await sql`INSERT INTO branch_push_settlement_outbox (push_id, document_id, document_title, lock_cut_update, push_update, trail_seed, state, claim_token, claim_epoch, claim_kind, claimed_at, lease_expires_at, attempt_count, last_error_code, last_error, blocked_at, completed_at, join_version, classified_join_version, settled_join_version) VALUES
      (${n}, ${id(10)}, 'Title', ${bytes}, ${bytes}, '{}', ${state}, ${claimed ? id(30) : null}, ${n + 2}, ${claimed ? "warm" : null}, ${claimed ? "2026-09-01T00:00:00Z" : null}, ${claimed ? "2026-10-11T00:00:00Z" : null}, ${n}, ${n === 3 ? "probe_blocked" : null}, ${n === 3 ? "retained error" : null}, ${n === 3 ? "2026-09-04T00:00:00Z" : null}, ${n === 4 ? "2026-09-05T00:00:00Z" : null}, 10, 8, ${n === 4 ? 10 : null})`;
  }
}

/**
 * #713's rows on a Work draft branch (pending edits and parts, dirty signals), in the shape
 * 0040/0041 leave: parts on branches the foundation deletes retire, the rest keep their branch.
 */
export async function seedEditLedger(sql: postgres.Sql) {
  const bytes = Buffer.from([0, 0]);
  const parts = [
    ["live", id(10), "draft-live"],
    ["peer", id(10), "peer"],
    ["orphan", id(12), "orphan-peer"],
    ["manifest", id(13), "manifest-draft"],
  ] as const;
  for (const [index, [name, documentId, branchId]] of parts.entries()) {
    const edit = id(60 + index);
    await sql`INSERT INTO document_edits (id, document_id, thread_id, actor, kind)
      VALUES (${edit}, ${documentId}, ${id(20)}, 'agent', 'write')`;
    await sql`INSERT INTO document_edit_parts (edit_id, ordinal, update, effect, frontier, origin, placement)
      VALUES (${edit}, 0, ${bytes}, ${sql.json({ name })}, ${sql.json([])}, ${sql.json({ kind: "pending" })},
        ${sql.json({ kind: "pending", branchId, generation: 1 })})`;
  }
  await sql`INSERT INTO document_edit_parts (edit_id, ordinal, update, effect, frontier, origin, placement)
    VALUES (${id(60)}, 1, ${bytes}, ${sql.json({ name: "live-done" })}, ${sql.json([])}, ${sql.json({ kind: "pending" })},
      ${sql.json({ kind: "discarded" })})`;
}

/**
 * Evidence #754's observation backfill (0039) versions: catalog rows (after 0037 resets the
 * catalog), a move receipt, and an availability head.
 */
export async function seedObservationEvidence(sql: postgres.Sql) {
  const entry = { kind: "file", entryId: id(10), name: "live.md", path: ["live.md"] };
  await sql`INSERT INTO context_catalog_scope_heads (scope_key, scope, head_revision) VALUES
    (${SCOPE_KEY}, ${sql.json({ kind: "project", projectId: id(2) })}, 1)`;
  await sql`INSERT INTO context_catalog_entries (scope_key, entry_id, entry) VALUES
    (${SCOPE_KEY}, ${id(10)}, ${sql.json(entry)})`;
  await sql`INSERT INTO context_catalog_commits (commit_id, scope_key, first_revision, last_revision, changes) VALUES
    (${id(40)}, ${SCOPE_KEY}, 1, 1, ${sql.json([{ operation: "upsert", ordinal: 0, entry }])})`;
  await sql`INSERT INTO context_operation_receipts (user_id, project_id, operation_id, receipt) VALUES
    (${id(1)}, ${id(2)}, ${id(41)}, ${sql.json({ operationId: id(41), command: { kind: "move" }, result: { ok: true } })})`;
  await sql`INSERT INTO context_availability_heads (authority_key, generation) VALUES (${SCOPE_KEY}, 7)`;
}
