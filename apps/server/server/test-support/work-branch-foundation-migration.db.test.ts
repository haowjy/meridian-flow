/**
 * Populated upgrade contract for 0044/0045 (and D62's 0046/0047 on top): the Work-branch foundation's data moves and
 * online retry, and `main`'s pending draft creates arriving hidden with their drafts' uses.
 * Rows are seeded in `main`'s 0036 shape, so the document-name migration (0037), the namespace
 * observation versions (0038/0039) and #713's edit ledger and dirty signals (0040/0041) run
 * over them first, as they do in a deploy; #713's edit rows are seeded after 0041.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextSourceId, DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts";
import { createDb, type Database } from "@meridian/database";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../../tools/dev/lib/migration-runner.js";
import { useComposedRuntimes } from "./composed-runtime.js";
import { draftTreeCommands } from "./draft-tree-commands.js";
import { draftTreeWorldOver, personalUserSource, type ScenarioWork } from "./draft-tree-seeds.js";
import {
  id,
  seedEditLedger,
  seedMainShape,
  seedObservationEvidence,
} from "./foundation-upgrade-fixture.js";
import {
  createScratchDatabase,
  journalIndex,
  MIGRATIONS,
  readJournal,
  type ScratchDatabase,
  stageThrough,
} from "./staged-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" && Boolean(databaseUrl);
const NAMES = "0037_old_adam_destine";
const MAIN_BETWEEN = [
  "0038_namespace_observation_schema",
  "0039_backfill_namespace_observation_versions",
  "0040_brainy_mimic",
  "0041_trail_dirty_signals",
  "0042_pretty_ricochet",
  "0043_mighty_paper_doll",
];
const FOUNDATION = "0044_work_branch_foundation";
const ONLINE = "0045_work_branch_foundation_online";

const FUNCTIONS_DIRECTORY = fileURLToPath(
  new URL("../../../../packages/database/src/functions/", import.meta.url),
);

/** pg_dump's session guard is random; all schema and data statements remain comparable. */
function dump(mode: "--schema-only" | "--data-only", targetUrl = databaseUrl ?? "") {
  // libpq URIs reject the runner's session parameters (`synchronous_commit`).
  const url = new URL(targetUrl);
  url.search = "";
  return execFileSync(
    "pg_dump",
    [
      url.toString(),
      mode,
      "--schema=public",
      "--schema=drizzle",
      "--no-owner",
      "--no-privileges",
      "--no-comments",
    ],
    { encoding: "utf8" },
  ).replace(/^\\(?:un)?restrict .*$/gm, "");
}

/** The repository's journal, where the foundation sits, and where the name migration does. */
async function foundationJournal() {
  const journal = await readJournal();
  return {
    journal,
    names: journalIndex(journal, NAMES),
    foundation: journalIndex(journal, FOUNDATION),
  };
}

describe.skipIf(!enabled)("Work-branch foundation migration (postgres)", () => {
  it("moves every row it reshapes and survives a retry from any statement of the online half", async () => {
    const scratch = await createScratchDatabase(databaseUrl ?? "", "foundation_upgrade");
    const target = scratch.sql;
    const writer = postgres(scratch.url, { max: 1, onnotice: () => {} });
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-foundation-upgrade-"));
    const migrations = MIGRATIONS;
    const { journal, names, foundation } = await foundationJournal();
    expect(journal.entries[foundation + 1]?.tag).toBe(ONLINE);
    expect(journal.entries.slice(names + 1, foundation).map((entry) => entry.tag)).toEqual(
      MAIN_BETWEEN,
    );
    const freshSchema = dump("--schema-only");
    try {
      await stageThrough(migrations, directory, journal, names);
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
      await seedMainShape(target);
      const projections = await target`
        SELECT id AS document_id, markdown_projection AS markdown, updated_at
        FROM documents WHERE kind = 'content' ORDER BY id`;
      const outbox = await target`SELECT * FROM branch_push_settlement_outbox ORDER BY push_id`;

      // The document-name migration, the observation migrations over evidence it left, #713's
      // ledger over its own rows, then the foundation's transactional half.
      await rm(directory, { recursive: true, force: true });
      await stageThrough(migrations, directory, journal, names + 1);
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
      await seedObservationEvidence(target);
      await rm(directory, { recursive: true, force: true });
      await stageThrough(migrations, directory, journal, foundation);
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
      await seedEditLedger(target);
      const dirtyBefore =
        await target`SELECT thread_id, turn_id FROM change_trail_dirty_log ORDER BY seq`;
      expect(dirtyBefore.length).toBeGreaterThan(0);
      await rm(directory, { recursive: true, force: true });
      await stageThrough(migrations, directory, journal, foundation + 1);
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });

      await rm(directory, { recursive: true, force: true });
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
          runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory }),
        ).rejects.toThrow(ONLINE);
        // Some live-path guard holds at every cut: the old one until the new one is valid.
        expect(await duplicateLive(), `cut ${cut}`).toEqual([]);
      }
      await writeFile(onlinePath, online.join("--> statement-breakpoint"));
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
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

      // Preserve #713's signals; retiring two pending parts appends their owner signals.
      expect(
        await target`SELECT thread_id, turn_id FROM change_trail_dirty_log ORDER BY seq`,
      ).toEqual([
        ...dirtyBefore,
        { thread_id: id(20), turn_id: null },
        { thread_id: id(20), turn_id: null },
      ]);
      // Parts pending on a branch the migration deleted (orphan peer, manifest) retire; the rest stay.
      expect(
        await target`SELECT edit_id, ordinal, placement FROM document_edit_parts ORDER BY edit_id, ordinal`,
      ).toEqual([
        {
          edit_id: id(60),
          ordinal: 0,
          placement: { kind: "pending", branchId: "draft-live", generation: 1 },
        },
        { edit_id: id(60), ordinal: 1, placement: { kind: "discarded" } },
        {
          edit_id: id(61),
          ordinal: 0,
          placement: { kind: "pending", branchId: "peer", generation: 1 },
        },
        { edit_id: id(62), ordinal: 0, placement: { kind: "retired" } },
      ]);
      // The manifest document went with its edits; every other edit stays.
      expect(await target`SELECT id FROM document_edits ORDER BY id`).toEqual([
        { id: id(60) },
        { id: id(61) },
        { id: id(62) },
      ]);
      // Settlement state lives on the batch: the outbox trigger watches inserts, the batch trigger state.
      expect(
        await target`SELECT tgname, tgrelid::regclass::text AS relation FROM pg_trigger
          WHERE tgrelid IN ('public.branch_push_settlement_batches'::regclass, 'public.branch_push_settlement_outbox'::regclass)
            AND tgname IN ('capture_change_trail_settlement', 'capture_change_trail_batch')
          ORDER BY tgname`,
      ).toEqual([
        { tgname: "capture_change_trail_batch", relation: "branch_push_settlement_batches" },
        { tgname: "capture_change_trail_settlement", relation: "branch_push_settlement_outbox" },
      ]);

      // main's observation backfill ran over the seeded evidence before the foundation.
      expect(
        await target`SELECT entry->>'observationVersion' AS version FROM context_catalog_entries`,
      ).toEqual([{ version: "0" }]);
      expect(
        await target`SELECT changes->0->'entry'->>'observationVersion' AS version FROM context_catalog_commits`,
      ).toEqual([{ version: "0" }]);
      expect(
        await target`SELECT receipt->>'observationVersion' AS version FROM context_operation_receipts`,
      ).toEqual([{ version: "0" }]);
      expect(
        await target`SELECT generation::text, namespace_generation::text FROM context_availability_heads`,
      ).toEqual([{ generation: "7", namespace_generation: "7" }]);

      // Projections leave the identity row; the retired manifest row goes, nothing else does.
      expect(
        await target`SELECT document_id, markdown, updated_at FROM document_markdown_projections ORDER BY document_id`,
      ).toEqual(projections);
      // Prose kept its identity under its canonical name: no extension.
      expect(await target`SELECT id, name, extension FROM documents ORDER BY id`).toEqual([
        { id: id(10), name: "live", extension: "" },
        { id: id(11), name: "trashed", extension: "" },
        { id: id(12), name: "second", extension: "" },
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
      // D62's pair (0046/0047, the chat-owned write mode and run identity) over the rows the
      // foundation just reshaped; chat-write-mode-migration.db.test.ts checks its data moves.
      await rm(directory, { recursive: true, force: true });
      await stageThrough(migrations, directory, journal, journal.entries.length);
      // The fixture's pending and blocked batches are the old release's unfinished work: the run
      // refuses before any of its migrations applies, then succeeds once recovery has drained them.
      const applied = await target`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      await expect(
        runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory }),
      ).rejects.toThrow(/unfinished settlement batches/);
      expect(await target`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`).toEqual(
        applied,
      );
      await target`UPDATE branch_push_settlement_batches SET state = 'completed', completed_at = now(),
        blocked_at = NULL, claim_token = NULL, claim_kind = NULL, claimed_at = NULL, lease_expires_at = NULL
        WHERE state IN ('pending', 'blocked')`;
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
      expect(
        await target`SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name IN ('ai_write_mode', 'default_ai_write_mode')
          ORDER BY table_name, column_name`,
      ).toEqual([
        { table_name: "threads", column_name: "ai_write_mode" },
        { table_name: "turns", column_name: "ai_write_mode" },
        { table_name: "works", column_name: "default_ai_write_mode" },
      ]);
      expect(
        await target`SELECT conname FROM pg_constraint
          WHERE connamespace = 'public'::regnamespace AND NOT convalidated`,
      ).toEqual([]);
      // The repository's SQL functions follow its migrations, as `db:migrate` applies them.
      for (const file of (await readdir(FUNCTIONS_DIRECTORY))
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await target.unsafe(await readFile(path.join(FUNCTIONS_DIRECTORY, file), "utf8"));
      }
      expect(dump("--schema-only", scratch.url)).toBe(freshSchema);
      const beforeRerun = dump("--data-only", scratch.url);
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
      expect(dump("--data-only", scratch.url)).toBe(beforeRerun);
      expect(dump("--schema-only", scratch.url)).toBe(freshSchema);
    } finally {
      await writer.end();
      await scratch.close();
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
  await sql`INSERT INTO documents (id, context_source_id, name, extension, kind) VALUES
    (${id(15)}, ${id(6)}, 'new', 'txt', 'content'),
    (${id(16)}, ${id(6)}, 'Lore.md', 'md', 'content')`;
  await sql`INSERT INTO folders (id, context_source_id, name) VALUES (${id(17)}, ${id(6)}, 'Lore')`;
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
  let scratch: ScratchDatabase | undefined;
  let db: Database | undefined;
  // Registered before the runtimes' cleanup, so it runs after it: rooms flush and the
  // app shuts down against the upgraded schema before the scratch database is dropped.
  afterEach(async () => {
    await db?.close();
    await scratch?.close();
  });
  const runtimes = useComposedRuntimes(() => {
    if (!db) throw new Error("The upgraded database is not open yet");
    return db;
  });

  it("stay hidden, listed new in each draft that uses them, revealed and tombstoned by id", async () => {
    scratch = await createScratchDatabase(databaseUrl ?? "", "pending_create_upgrade");
    const target = scratch.sql;
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-pending-create-upgrade-"));
    try {
      const { journal, names } = await foundationJournal();
      await stageThrough(MIGRATIONS, directory, journal, names);
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
      await seedPendingCreates(target);
      // 0040 added live_cut; a branch the train wrote to has the cut its first write set, which is
      // the baseline the review-base conversion reads.
      await rm(directory, { recursive: true, force: true });
      await stageThrough(MIGRATIONS, directory, journal, journalIndex(journal, FOUNDATION));
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
      await target`UPDATE document_branches SET live_cut = ${Buffer.from([0, 0])}`;
      await rm(directory, { recursive: true, force: true });
      await stageThrough(MIGRATIONS, directory, journal, journal.entries.length);
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    db = createDb(scratch.url, { max: 4 });
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

    // Each draft's create is identity only; the name migration ran first, so the hidden row
    // holds the canonical place.
    expect(await target`SELECT node_id FROM draft_tree_changes ORDER BY node_id, draft_id`).toEqual(
      [{ node_id: created }, { node_id: shared }, { node_id: shared }],
    );
    expect(
      await target`SELECT id, name, extension FROM documents WHERE id IN (${created}, ${shared}) ORDER BY id`,
    ).toEqual(
      [
        { id: created, name: "new", extension: "" },
        { id: shared, name: "shared", extension: "" },
      ].sort((l, r) => l.id.localeCompare(r.id)),
    );
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

    // A live create at any prose spelling of its path reveals the same identity.
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
