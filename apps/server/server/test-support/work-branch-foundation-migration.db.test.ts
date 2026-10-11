/**
 * Populated upgrade contract for 0037/0038: the Work-branch foundation's data moves and
 * online retry, and `main`'s pending draft creates arriving hidden with their drafts' uses.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextSourceId, DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts";
import { createDb, type Database } from "@meridian/database";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../../tools/dev/lib/migration-runner.js";
import { useComposedRuntimes } from "./composed-runtime.js";
import { draftTreeCommands } from "./draft-tree-commands.js";
import { draftTreeWorldOver, personalUserSource, type ScenarioWork } from "./draft-tree-seeds.js";
import {
  isolateSchemas,
  journalIndex,
  readMigrationJournal,
  restoreSchemas,
  stageThrough,
} from "./migration-upgrade.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" && Boolean(databaseUrl);
const id = (n: number) => `73600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FOUNDATION = "0037_work_branch_foundation";
const ONLINE = "0038_work_branch_foundation_online";

/** Rows in `main`'s 0036 shape: every kind of row the foundation migration moves. */
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

const PREFIX = "foundation_upgrade";

/** The repository's migration journal and the index of the foundation's entry in it. */
async function readJournal() {
  const journal = await readMigrationJournal();
  return { journal, foundation: journalIndex(journal, FOUNDATION) };
}

describe.skipIf(!enabled)("Work-branch foundation migration (postgres)", () => {
  it("moves every row it reshapes and survives a retry from any statement of the online half", async () => {
    const target = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
    const writer = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-foundation-upgrade-"));
    const { journal, foundation } = await readJournal();
    expect(journal.entries[foundation + 1]?.tag).toBe(ONLINE);
    let isolated = false;
    try {
      await isolateSchemas(target, PREFIX);
      isolated = true;
      await stageThrough(directory, journal, foundation);
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
      await seedMainShape(target);
      const projections = await target`
        SELECT id AS document_id, markdown_projection AS markdown, updated_at
        FROM documents WHERE kind = 'content' ORDER BY id`;
      const outbox = await target`SELECT * FROM branch_push_settlement_outbox ORDER BY push_id`;

      await stageThrough(directory, journal, foundation + 1);
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });

      await stageThrough(directory, journal, foundation + 2);
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
      if (isolated) await restoreSchemas(target, PREFIX);
      await target.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * `main`'s pending draft creates (pre-foundation shape): an empty live row the live
 * manifest leaves out, named by an active `manifest_membership` row on the Work's
 * manifest draft. Alpha created `new.md` and `shared.md` (Beta then drafted text into
 * it), and created then discarded `gone.md`; `kept.md` is the writer's own empty live
 * document Alpha drafted into, which `main` showed live. Gamma only ever opened the
 * manifest's draft.
 */
async function seedPendingCreates(sql: postgres.Sql) {
  const empty = Buffer.from([0, 0]);
  const vector = Buffer.from([0]);
  await sql`INSERT INTO users (id, external_id, email) VALUES (${id(1)}, 'pending-create-upgrade', 'pending@example.test')`;
  await sql`INSERT INTO projects (id, user_id, name, slug) VALUES (${id(2)}, ${id(1)}, 'Upgrade', 'upgrade')`;
  await sql`INSERT INTO works (project_id, created_by_user_id, name, is_no_work) VALUES (${id(2)}, ${id(1)}, 'No Work', true)`;
  await sql`INSERT INTO works (id, project_id, created_by_user_id, name, slug, ai_write_mode) VALUES
    (${id(3)}, ${id(2)}, ${id(1)}, 'Alpha', 'alpha', 'draft'),
    (${id(4)}, ${id(2)}, ${id(1)}, 'Beta', 'beta', 'draft'),
    (${id(5)}, ${id(2)}, ${id(1)}, 'Gamma', 'gamma', 'draft')`;
  await sql`INSERT INTO context_sources (id, project_id, name, slug, is_primary, sort_order) VALUES
    (${id(6)}, ${id(2)}, 'manuscript', 'manuscript', true, 0),
    (${id(7)}, ${id(2)}, 'kb', 'kb', false, 1),
    (${id(8)}, ${id(2)}, 'unfiled', 'unfiled', false, 2)`;
  for (const [thread, turn, work] of [
    [id(20), id(22), id(3)],
    [id(21), id(23), id(4)],
  ] as const) {
    await sql`INSERT INTO threads (id, project_id, root_thread_id, created_by_user_id, title) VALUES (${thread}, ${id(2)}, ${thread}, ${id(1)}, 'Thread')`;
    await sql`INSERT INTO turns (id, thread_id, position, role, origin, status) VALUES (${turn}, ${thread}, 1, 'assistant', 'assistant', 'complete')`;
    await sql`INSERT INTO thread_works (thread_id, work_id, project_id) VALUES (${thread}, ${work}, ${id(2)})`;
  }
  await sql`INSERT INTO documents (id, context_source_id, name, kind) VALUES
    (${id(10)}, ${id(6)}, 'manifest', 'manifest'),
    (${id(11)}, ${id(6)}, 'new', 'content'),
    (${id(12)}, ${id(6)}, 'shared', 'content'),
    (${id(13)}, ${id(6)}, 'gone', 'content'),
    (${id(14)}, ${id(6)}, 'kept', 'content')`;
  // Each content row's empty Yjs authority, as a create installs it: no update rows yet.
  for (const n of [11, 12, 13, 14]) {
    const [checkpoint] = await sql`INSERT INTO document_yjs_checkpoints
      (document_id, authority_id, authority_generation, attribution_manifest, state, state_vector, up_to_seq, reason)
      VALUES (${id(n)}, ${id(n)}, 1, ${sql.json({ version: 1, floor: null, attributions: [] })}, ${empty}, ${vector}, 0, 'initial')
      RETURNING id`;
    await sql`INSERT INTO document_yjs_heads (document_id, authority_id, latest_update_seq, latest_state_vector, latest_checkpoint_id)
      VALUES (${id(n)}, ${id(n)}, 0, ${vector}, ${checkpoint?.id})`;
  }
  await sql`INSERT INTO document_branches (id, document_id, kind, work_id, status, state, state_vector) VALUES
    ('alpha-manifest', ${id(10)}, 'work_draft', ${id(3)}, 'active', ${empty}, ${vector}),
    ('beta-manifest', ${id(10)}, 'work_draft', ${id(4)}, 'active', ${empty}, ${vector}),
    ('gamma-manifest', ${id(10)}, 'work_draft', ${id(5)}, 'active', ${empty}, ${vector}),
    ('alpha-new', ${id(11)}, 'work_draft', ${id(3)}, 'active', ${empty}, ${vector}),
    ('alpha-shared', ${id(12)}, 'work_draft', ${id(3)}, 'active', ${empty}, ${vector}),
    ('beta-shared', ${id(12)}, 'work_draft', ${id(4)}, 'active', ${empty}, ${vector}),
    ('alpha-gone', ${id(13)}, 'work_draft', ${id(3)}, 'active', ${empty}, ${vector}),
    ('alpha-kept', ${id(14)}, 'work_draft', ${id(3)}, 'active', ${empty}, ${vector})`;
  const membership = (documentId: string, present: boolean) =>
    sql.json({ kind: "manifest_membership", present, documentId });
  await sql`INSERT INTO branch_write_journal (branch_id, generation, update_data, draft_base_update_seq, update_meta, status, thread_id) VALUES
    ('alpha-manifest', 1, ${empty}, 0, ${membership(id(11), true)}, 'active', ${id(20)}),
    ('alpha-manifest', 1, ${empty}, 0, ${membership(id(12), true)}, 'active', ${id(20)}),
    ('alpha-manifest', 1, ${empty}, 0, ${membership(id(13), true)}, 'active', ${id(20)}),
    ('alpha-manifest', 1, ${empty}, 0, ${membership(id(13), false)}, 'active', NULL),
    ('alpha-new', 1, ${empty}, 0, NULL, 'active', ${id(20)}),
    ('alpha-shared', 1, ${empty}, 0, NULL, 'active', ${id(20)}),
    ('beta-shared', 1, ${empty}, 0, NULL, 'active', ${id(21)}),
    ('alpha-gone', 1, ${empty}, 0, NULL, 'discarded', ${id(20)}),
    ('alpha-kept', 1, ${empty}, 0, NULL, 'active', ${id(20)})`;
}

describe.skipIf(!enabled)("Pending draft creates across the foundation upgrade (postgres)", () => {
  const target = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
  let db: Database | undefined;
  let isolated = false;
  // Registered before the runtimes' cleanup, so it runs after it: rooms flush and the
  // app shuts down against the upgraded schema before the saved one comes back.
  afterEach(async () => {
    await db?.close();
    if (isolated) await restoreSchemas(target, PREFIX);
    await target.end();
  });
  const runtimes = useComposedRuntimes(() => {
    if (!db) throw new Error("The upgraded database is not open yet");
    return db;
  });

  it("stay hidden, listed new in each draft that uses them, revealed and tombstoned by id", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-pending-create-upgrade-"));
    try {
      const { journal, foundation } = await readJournal();
      await isolateSchemas(target, PREFIX);
      isolated = true;
      await stageThrough(directory, journal, foundation);
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
      await seedPendingCreates(target);
      await rm(directory, { recursive: true, force: true });
      await stageThrough(directory, journal, journal.entries.length);
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    db = createDb(databaseUrl ?? "", { max: 4 });
    const runtime = await runtimes.compose();
    const personal = await personalUserSource(db, id(1) as UserId);
    const project = {
      id: id(2) as ProjectId,
      userId: id(1) as UserId,
      personalId: personal.projectId,
      sources: {
        manuscript: id(6) as ContextSourceId,
        kb: id(7) as ContextSourceId,
        unfiled: id(8) as ContextSourceId,
        user: personal.sourceId,
      },
    };
    const world = draftTreeWorldOver(db, project, [id(3) as WorkId, id(4) as WorkId]);
    const s = { ...world, ...draftTreeCommands(world, () => ({ runtime, runtimes })) };
    const work = (n: number, thread: number, turn: number, slug: string): ScenarioWork => ({
      id: id(n) as WorkId,
      slug,
      threadId: id(thread) as ScenarioWork["threadId"],
      turnId: id(turn),
      mode: "draft",
    });
    const alpha = work(3, 20, 22, "alpha");
    const beta = work(4, 21, 23, "beta");
    const [created, shared, discarded, kept] = [11, 12, 13, 14].map((n) => id(n) as DocumentId);
    const isNew = async (of: ScenarioWork) =>
      (await s.items(of)).filter((item) => item.isNew).map((item) => item.documentId);
    const tombstoned = async (documentId: string) =>
      (
        await target`SELECT deleted_at IS NOT NULL AS gone FROM documents WHERE id = ${documentId}`
      )[0]?.gone;

    // A pending create is not live; the writer's own empty document still is.
    const live = s.view("live");
    expect(await live.idAt("new.md")).toBeNull();
    expect(await live.idAt("shared.md")).toBeNull();
    expect(await live.idAt("gone.md")).toBeNull();
    expect(await live.idAt("kept.md")).toBe(kept);
    // Each draft that used it lists it new; one `main` discarded is tombstoned.
    expect((await isNew(alpha)).sort()).toEqual([created, shared].sort());
    expect(await isNew(beta)).toEqual([shared]);
    expect(await tombstoned(discarded)).toBe(true);
    // A Work whose only branch was the manifest's has no draft.
    expect(await s.draftStatuses(work(5, 20, 22, "gamma"))).toEqual([]);

    // A live create at its path reveals the same identity.
    expect(await s.writer.create("new.md")).toMatchObject({
      status: "created",
      documentId: created,
    });
    expect(await live.idAt("new.md")).toBe(created);

    // The last use's Discard tombstones it; an earlier one leaves it to the other draft.
    await s.discard(alpha, [shared]);
    expect(await tombstoned(shared)).toBe(false);
    expect(await isNew(beta)).toEqual([shared]);
    await s.discard(beta, [shared]);
    expect(await tombstoned(shared)).toBe(true);
  }, 120_000);
});
