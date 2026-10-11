/** Populated upgrade contract for 0036/0037: the Work-branch foundation's data moves and online retry. */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../../../tools/dev/lib/migration-runner.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" && Boolean(databaseUrl);
const id = (n: number) => `73600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FOUNDATION = "0036_work_branch_foundation";
const ONLINE = "0037_work_branch_foundation_online";

/** Rows in `main`'s 0035 shape: every kind of row the foundation migration moves. */
async function seedMainShape(sql: postgres.Sql) {
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
    ('orphan-peer', ${id(12)}, 'thread_peer', NULL, NULL, NULL, ${id(20)}, 'active', ${bytes}, ${bytes})`;
  for (let n = 1; n <= 4; n++) {
    const state = n === 3 ? "blocked" : n === 4 ? "completed" : "pending";
    const claimed = n === 2;
    await sql`INSERT INTO push_lineage (id, branch_generation, document_id, journal_ids, idempotency_key)
      VALUES (${n}, 1, ${id(10)}, '{}', ${`push-${n}`})`;
    await sql`INSERT INTO branch_push_settlement_outbox (push_id, document_id, document_title, lock_cut_update, push_update, trail_seed, state, claim_token, claim_epoch, claim_kind, claimed_at, lease_expires_at, attempt_count, last_error_code, last_error, blocked_at, completed_at, join_version, classified_join_version, settled_join_version) VALUES
      (${n}, ${id(10)}, 'Title', ${bytes}, ${bytes}, '{}', ${state}, ${claimed ? id(30) : null}, ${n + 2}, ${claimed ? "warm" : null}, ${claimed ? "2026-09-01T00:00:00Z" : null}, ${claimed ? "2026-10-11T00:00:00Z" : null}, ${n}, ${n === 3 ? "probe_blocked" : null}, ${n === 3 ? "retained error" : null}, ${n === 3 ? "2026-09-04T00:00:00Z" : null}, ${n === 4 ? "2026-09-05T00:00:00Z" : null}, 10, 8, ${n === 4 ? 10 : null})`;
  }
}

/** Stages the first `n` journal entries of `migrations` in `directory`, as a deploy at that point would. */
async function stageThrough(
  migrations: string,
  directory: string,
  journal: { entries: { tag: string }[] },
  n: number,
) {
  await cp(migrations, directory, { recursive: true });
  for (const entry of journal.entries.slice(n)) await rm(path.join(directory, `${entry.tag}.sql`));
  await writeFile(
    path.join(directory, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, n) }),
  );
}

describe.skipIf(!enabled)("Work-branch foundation migration (postgres)", () => {
  it("moves every row it reshapes and survives a retry from any statement of the online half", async () => {
    const target = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
    const writer = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-foundation-upgrade-"));
    const migrations = path.resolve(
      import.meta.dirname,
      "../../../../packages/database/src/migrations",
    );
    const journal = JSON.parse(await readFile(path.join(migrations, "meta/_journal.json"), "utf8"));
    const foundation = journal.entries.findIndex(
      (entry: { tag: string }) => entry.tag === FOUNDATION,
    );
    expect(journal.entries[foundation + 1]?.tag).toBe(ONLINE);
    let isolated = false;
    try {
      await target.begin(async (tx) => {
        await tx`ALTER SCHEMA public RENAME TO foundation_upgrade_saved_public`;
        await tx`ALTER SCHEMA drizzle RENAME TO foundation_upgrade_saved_drizzle`;
        await tx`CREATE SCHEMA public`;
        await tx`ALTER EXTENSION pg_trgm SET SCHEMA public`;
      });
      isolated = true;
      await stageThrough(migrations, directory, journal, foundation);
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
      await seedMainShape(target);
      const projections = await target`
        SELECT id AS document_id, markdown_projection AS markdown, updated_at
        FROM documents WHERE kind = 'content' ORDER BY id`;
      const outbox = await target`SELECT * FROM branch_push_settlement_outbox ORDER BY push_id`;

      await stageThrough(migrations, directory, journal, foundation + 1);
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });

      await stageThrough(migrations, directory, journal, foundation + 2);
      // A failed concurrent build leaves an invalid remnant; the runner replaces it.
      await expect(
        target.unsafe(
          'CREATE UNIQUE INDEX CONCURRENTLY "documents_context_folder_name_live" ON documents (context_source_id)',
        ),
      ).rejects.toMatchObject({ code: "23505" });
      // Fail the online half at every statement in turn; each retry starts over from the first.
      const onlinePath = path.join(directory, `${ONLINE}.sql`);
      const online = (await readFile(onlinePath, "utf8")).split("--> statement-breakpoint");
      const duplicateLive = () =>
        writer`INSERT INTO documents (context_source_id, name) VALUES (${id(6)}, 'live')
          ON CONFLICT DO NOTHING RETURNING id`;
      for (let cut = 1; cut < online.length; cut++) {
        await writeFile(
          onlinePath,
          [...online.slice(0, cut), "\nSELECT 1 / 0;\n"].join("--> statement-breakpoint"),
        );
        await expect(
          runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory }),
        ).rejects.toThrow(ONLINE);
        // Some live-path guard holds at every cut: the old one until the new one is valid.
        expect(await duplicateLive(), `cut ${cut}`).toEqual([]);
      }
      await writeFile(onlinePath, online.join("--> statement-breakpoint"));
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
      expect(await duplicateLive()).toEqual([]);
      expect(
        await target`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
      ).toHaveLength(1);

      expect(
        await target`SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relnamespace = 'public'::regnamespace AND NOT i.indisvalid`,
      ).toEqual([]);
      expect(
        await target`SELECT conname FROM pg_constraint
          WHERE connamespace = 'public'::regnamespace AND NOT convalidated`,
      ).toEqual([]);

      // Projections leave the identity row; the retired manifest row goes, nothing else does.
      expect(
        await target`SELECT document_id, markdown, updated_at FROM document_markdown_projections ORDER BY document_id`,
      ).toEqual(projections);
      expect((await target`SELECT id FROM documents ORDER BY id`).map((row) => row.id)).toEqual([
        id(10),
        id(11),
        id(12),
      ]);
      expect(
        await target`SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'documents'
            AND column_name IN ('kind', 'markdown_projection')`,
      ).toEqual([]);

      // Each push is a batch of one with a deterministic id and its claim and terminal state.
      const batches = await target`
        SELECT o.push_id, o.batch_id, b.*, o.document_id, o.document_title, o.lock_cut_update,
          o.push_update, o.trail_seed, o.join_version, o.classified_join_version
        FROM branch_push_settlement_outbox o JOIN branch_push_settlement_batches b ON b.id = o.batch_id
        ORDER BY o.push_id`;
      expect(batches).toHaveLength(4);
      const copied = [
        "state",
        "claim_token",
        "claim_epoch",
        "claim_kind",
        "claimed_at",
        "lease_expires_at",
        "available_at",
        "attempt_count",
        "last_error_code",
        "last_error",
        "blocked_at",
        "completed_at",
        "created_at",
        "updated_at",
        "document_id",
        "document_title",
        "lock_cut_update",
        "push_update",
        "trail_seed",
        "join_version",
        "classified_join_version",
      ];
      for (const [index, batch] of batches.entries()) {
        for (const field of copied) expect(batch[field], field).toEqual(outbox[index]?.[field]);
        const [expected] =
          await target`SELECT md5('branch-push-settlement:' || ${String(batch.push_id)})::uuid AS id`;
        expect(batch.batch_id).toBe(expected?.id);
        expect(batch.abandoned_at).toBeNull();
      }

      // One draft per Work with branches; a peer takes its upstream's draft; an ownerless peer goes.
      const drafts = await target`
        SELECT id, origin_work_id, created_by, status, project_id FROM drafts ORDER BY origin_work_id`;
      expect(drafts.map(({ id: _, ...draft }) => draft)).toEqual([
        { origin_work_id: id(3), created_by: id(1), status: "active", project_id: id(2) },
        { origin_work_id: id(4), created_by: id(1), status: "active", project_id: id(2) },
      ]);
      const draftOf = (work: string) => drafts.find((draft) => draft.origin_work_id === work)?.id;
      expect(await target`SELECT id, draft_id, status FROM document_branches ORDER BY id`).toEqual([
        { id: "draft-closed", draft_id: draftOf(id(3)), status: "closed" },
        // Soft delete no longer closes draft branches, so the one a Work delete closed reopens.
        { id: "draft-deleted-work", draft_id: draftOf(id(4)), status: "active" },
        { id: "draft-live", draft_id: draftOf(id(3)), status: "active" },
        { id: "peer", draft_id: draftOf(id(3)), status: "active" },
      ]);
      expect(
        await target`SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'document_branches'
            AND column_name IN ('work_id', 'deleted_by_work_id')`,
      ).toEqual([]);
    } finally {
      await writer.end();
      if (isolated)
        await target.begin(async (tx) => {
          await tx`ALTER EXTENSION pg_trgm SET SCHEMA foundation_upgrade_saved_public`;
          await tx`DROP SCHEMA IF EXISTS public CASCADE`;
          await tx`DROP SCHEMA IF EXISTS drizzle CASCADE`;
          await tx`ALTER SCHEMA foundation_upgrade_saved_public RENAME TO public`;
          await tx`ALTER SCHEMA foundation_upgrade_saved_drizzle RENAME TO drizzle`;
        });
      await target.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
