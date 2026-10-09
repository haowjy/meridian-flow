/** Real-shaped pre-0032 Scratch rows shared by the upgrade contract and live probe. */
import type postgres from "postgres";

export const archiveId = (n: number) => `72400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const archiveNoteState = Buffer.from(
  "0103904e0007010b70726f73656d6972726f7203097061726167726170680700904e00060400904e01174c696e206b6565707320746865206a616465206d61702e00",
  "hex",
);
const vector = Buffer.from("01904e19", "hex");

export async function seedScratchArchive(sql: postgres.Sql, userId = archiveId(1)) {
  await sql`INSERT INTO users (id, external_id, email) VALUES (${userId}, 'scratch-archive-fixture', 'archive@example.test') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO projects (id, user_id, name, slug) VALUES
    (${archiveId(2)}, ${userId}, 'Scratch Archive', 'scratch-archive'),
    (${archiveId(3)}, ${userId}, 'Missing Unfiled', 'missing-unfiled')`;
  await sql`INSERT INTO works (id, project_id, created_by_user_id, name, is_no_work) VALUES
    (${archiveId(4)}, ${archiveId(2)}, ${userId}, 'No Work', true),
    (${archiveId(5)}, ${archiveId(3)}, ${userId}, 'No Work', true)`;
  await sql`INSERT INTO context_sources (id, work_id, name, slug, scope) VALUES
    (${archiveId(6)}, ${archiveId(4)}, 'Scratch', 'scratch', 'work'),
    (${archiveId(7)}, ${archiveId(5)}, 'Scratch', 'scratch', 'work')`;
  await sql`INSERT INTO context_sources (id, project_id, name, slug) VALUES
    (${archiveId(8)}, ${archiveId(2)}, 'Unfiled', 'unfiled'),
    (${archiveId(9)}, ${archiveId(2)}, 'Manuscript', 'manuscript')`;
  await sql`INSERT INTO folders (id, context_source_id, parent_id, name, deleted_at) VALUES
    (${archiveId(10)}, ${archiveId(8)}, NULL, 'Scratch', NULL),
    (${archiveId(11)}, ${archiveId(6)}, NULL, 'nested', NULL),
    (${archiveId(12)}, ${archiveId(6)}, ${archiveId(11)}, 'deep', NULL),
    (${archiveId(13)}, ${archiveId(6)}, NULL, 'trashed-folder', now())`;
  await sql`INSERT INTO documents (id, context_source_id, folder_id, name, markdown_projection, deleted_at) VALUES
    (${archiveId(14)}, ${archiveId(6)}, ${archiveId(12)}, 'jade-map', 'Lin keeps the jade map.', NULL),
    (${archiveId(15)}, ${archiveId(6)}, NULL, 'root-note', 'A root note.', NULL),
    (${archiveId(16)}, ${archiveId(6)}, ${archiveId(13)}, 'trashed-note', 'Keep this trashed note.', now()),
    (${archiveId(17)}, ${archiveId(7)}, NULL, 'second-note', 'Second project note.', NULL),
    (${archiveId(18)}, ${archiveId(9)}, NULL, 'chapter', '[Old Scratch](scratch://@/nested/deep/jade-map.md)\n\n[Unfiled note](unfiled://Scratch (2)/nested/deep/jade-map.md)', NULL)`;
  await sql`INSERT INTO document_yjs_heads (document_id, authority_id, latest_state_vector) VALUES (${archiveId(14)}, ${archiveId(20)}, ${vector})`;
  const [checkpoint] =
    await sql`INSERT INTO document_yjs_checkpoints (document_id, authority_id, authority_generation, attribution_manifest, state, state_vector, up_to_seq)
    VALUES (${archiveId(14)}, ${archiveId(20)}, 1, '{}', ${archiveNoteState}, ${vector}, 0) RETURNING id`;
  await sql`UPDATE document_yjs_heads SET latest_checkpoint_id = ${checkpoint?.id} WHERE document_id = ${archiveId(14)}`;
  await sql`INSERT INTO document_yjs_updates (document_id, authority_id, authority_generation, admission_sequence, update_data, origin_type, actor_user_id)
    VALUES (${archiveId(14)}, ${archiveId(20)}, 1, 1, ${Buffer.from([0, 0])}, 'user', ${userId})`;
  await sql`INSERT INTO user_recent_documents (user_id, document_id) VALUES (${userId}, ${archiveId(14)})`;
  await sql`INSERT INTO document_previous_locations (context_source_id, path, document_id) VALUES (${archiveId(6)}, 'earlier-name.md', ${archiveId(14)})`;
  await sql`INSERT INTO document_previous_locations (context_source_id, path, document_id) VALUES
    (${archiveId(8)}, 'Scratch (2)/nested/deep/jade-map.md', ${archiveId(18)}),
    (${archiveId(8)}, 'unrelated-alias.md', ${archiveId(18)})`;
  await sql`INSERT INTO upload_intakes (project_id, intake_id, actor_user_id, work_id, context_source_id, document_id, fingerprint, byte_digest, filename, mime_type, final_path, object_key, file_type, canonical_uri, location_revision, state) VALUES
    (${archiveId(2)}, 'reserved-intake', ${userId}, ${archiveId(4)}, ${archiveId(6)}, ${archiveId(21)}, 'retained-fingerprint', ${"a".repeat(64)}, 'map.png', 'image/png', 'map.png', ${`uploads/${archiveId(2)}/${archiveId(21)}`}, 'png', 'scratch://@/map.png', ${archiveId(22)}, 'reserved')`;
  for (const [scopeKey, scope] of [
    [`project:${archiveId(2)}`, { kind: "project", projectId: archiveId(2) }],
    [
      `work:${archiveId(2)}:${archiveId(4)}`,
      { kind: "work", projectId: archiveId(2), workId: archiveId(4) },
    ],
  ] as const) {
    await sql`INSERT INTO context_catalog_scope_heads (scope_key, scope) VALUES (${scopeKey}, ${sql.json(scope)})`;
    await sql`INSERT INTO context_catalog_entries (scope_key, entry_id, entry) VALUES (${scopeKey}, 'stale', '{"uri":"scratch://@/obsolete.md"}')`;
    await sql`INSERT INTO context_catalog_commits (commit_id, scope_key, first_revision, last_revision, changes) VALUES (${archiveId(23)}, ${scopeKey}, 1, 1, '[]')`;
  }
}
