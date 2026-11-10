/**
 * Fresh-baseline catalog and bootstrap contracts on runner-owned PostgreSQL.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - baseline journal hashes and database-enforced locked No Work bootstrap constraints (kb/wiki/conventions/practice/database-migrations.md#merged-migration-history-never-changes)
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../../tools/dev/lib/migration-runner";
import { disposableTestDatabaseTarget } from "../../../tools/dev/lib/test-db-lifecycle";
import { assertThrowawayDatabaseForRunDbTests } from "./__test-support__/db-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

/**
 * Applies the journal up to (not including) `firstTag`, runs `seed`, applies the rest, then runs
 * `verify`, all on a scratch database. A row-transform migration is checked on populated tables.
 */
async function upgradeWithRows(
  databaseUrl: string,
  firstTag: string,
  seed: (target: postgres.Sql) => Promise<void>,
  verify: (target: postgres.Sql) => Promise<void>,
) {
  assertThrowawayDatabaseForRunDbTests(databaseUrl);
  const journal = JSON.parse(
    await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const firstApplied = journal.entries.findIndex((entry) => entry.tag === firstTag);
  if (firstApplied < 0) throw new Error(`Migration ${firstTag} is missing from the journal`);

  const scratchTarget = disposableTestDatabaseTarget(
    databaseUrl,
    `populated_migrations_${process.pid}_${Date.now()}`,
  );
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = postgres(scratchTarget.databaseUrl, { max: 1 });
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "meridian-populated-migrations-"));
  const sourceDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
  const partialDirectory = path.join(temporaryRoot, "migrations");

  try {
    await admin.unsafe(`CREATE DATABASE "${scratchTarget.databaseName}"`);
    await mkdir(path.join(partialDirectory, "meta"), { recursive: true });
    const appliedEntries = journal.entries.slice(0, firstApplied);
    const appliedTags = new Set(appliedEntries.map((entry) => `${entry.tag}.sql`));
    for (const file of await readdir(sourceDirectory)) {
      if (file.endsWith(".sql") && appliedTags.has(file))
        await symlink(path.join(sourceDirectory, file), path.join(partialDirectory, file));
      if (file.endsWith(".ts"))
        await symlink(path.join(sourceDirectory, file), path.join(partialDirectory, file));
    }
    await writeFile(
      path.join(partialDirectory, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: appliedEntries }),
    );

    await runMigrations({
      databaseUrl: scratchTarget.databaseUrl,
      migrationsDirectory: partialDirectory,
    });
    await seed(target);
    await runMigrations({
      databaseUrl: scratchTarget.databaseUrl,
      migrationsDirectory: sourceDirectory,
    });
    await verify(target);
  } finally {
    await target.end();
    await admin.end();
    if (!scratchTarget.managedTemplate) {
      const cleanup = postgres(adminUrl.toString(), { max: 1 });
      try {
        await cleanup.unsafe(
          `DROP DATABASE IF EXISTS "${scratchTarget.databaseName}" WITH (FORCE)`,
        );
      } finally {
        await cleanup.end();
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (!enabled || !databaseUrl) {
  describe.skip("fresh database migrations (postgres)", () => {});
} else {
  describe("fresh database migrations (postgres)", () => {
    it("installs the baseline and ordered journal entries", async () => {
      const journal = JSON.parse(
        await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
      ) as { entries: Array<{ idx: number; tag: string; when: number }> };
      expect(journal.entries[0]).toMatchObject({ idx: 0, tag: "0000_baseline" });
      for (let index = 1; index < journal.entries.length; index += 1) {
        expect(journal.entries[index]?.when).toBeGreaterThan(journal.entries[index - 1]?.when ?? 0);
      }
      const baseline = await readFile(new URL("./migrations/0000_baseline.sql", import.meta.url));
      const target = postgres(databaseUrl, { max: 1 });
      try {
        const applied =
          await target`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
        expect(applied).toHaveLength(journal.entries.length);
        expect(applied[0]).toEqual({
          hash: createHash("sha256").update(baseline).digest("hex"),
          created_at: String(journal.entries[0]?.when),
        });
      } finally {
        await target.end();
      }
    });
    it("supports locked No Work and primary thread bindings without seeded identities", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      try {
        await target.begin(async (tx) => {
          const [user] = await tx`INSERT INTO users (external_id, email)
            VALUES ('baseline-no-work', 'baseline-no-work@example.test') RETURNING id`;
          const [project] = await tx`INSERT INTO projects (user_id, name, slug)
            VALUES (${user.id}, 'Baseline', 'baseline') RETURNING id`;
          // Projects created after migration are bootstrapped by the application, not a trigger.
          expect(await tx`SELECT id FROM works WHERE project_id = ${project.id}`).toEqual([]);
          const [work] =
            await tx`INSERT INTO works (project_id, created_by_user_id, name, is_no_work)
            VALUES (${project.id}, ${user.id}, 'No Work', true)
            RETURNING id, handle, status, archived_at, default_ai_write_mode`;
          expect(work).toMatchObject({
            handle: null,
            status: null,
            archived_at: null,
            default_ai_write_mode: "direct",
          });
          await expect(
            tx.savepoint(
              (save) => save`UPDATE works SET archived_at = now() WHERE id = ${work.id}`,
            ),
          ).rejects.toMatchObject({ constraint_name: "works_no_work_not_archived" });
          await expect(
            tx.savepoint((save) => save`UPDATE works SET handle = 'w1' WHERE id = ${work.id}`),
          ).rejects.toMatchObject({ constraint_name: "works_no_work_handle" });
          await expect(
            tx.savepoint(
              (save) => save`INSERT INTO works (project_id, created_by_user_id, name, is_no_work)
            VALUES (${project.id}, ${user.id}, 'Another No Work', true)`,
            ),
          ).rejects.toMatchObject({ constraint_name: "works_project_no_work_active" });
          const threadId = crypto.randomUUID();
          const [thread] =
            await tx`INSERT INTO threads (id, root_thread_id, project_id, created_by_user_id)
            VALUES (${threadId}, ${threadId}, ${project.id}, ${user.id}) RETURNING id`;
          await tx`INSERT INTO thread_works (thread_id, work_id, project_id, is_primary)
            VALUES (${thread.id}, ${work.id}, ${project.id}, true)`;
          expect(
            await tx`SELECT work_id, is_primary FROM thread_works WHERE thread_id = ${thread.id}`,
          ).toEqual([{ work_id: work.id, is_primary: true }]);
          await tx`DELETE FROM users WHERE id = ${user.id}`;
        });
      } finally {
        await target.end();
      }
    });
    it("keeps lineage Scratch independent of the first chat row and enforces its owner shape", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      try {
        await target.begin(async (tx) => {
          const [user] =
            await tx`INSERT INTO users (external_id, email) VALUES ('lineage-shape', 'lineage-shape@example.test') RETURNING id`;
          const [project] =
            await tx`INSERT INTO projects (user_id, name, slug) VALUES (${user.id}, 'Lineage', 'lineage') RETURNING id`;
          const root = crypto.randomUUID();
          await tx`INSERT INTO threads (id, root_thread_id, project_id, created_by_user_id, ref) VALUES (${root}, ${root}, ${project.id}, ${user.id}, 'c12')`;
          const [source] =
            await tx`INSERT INTO context_sources (project_id, root_thread_id, scope, name, slug) VALUES (${project.id}, ${root}, 'lineage', 'Scratch', 'scratch') RETURNING id`;
          await expect(
            tx.savepoint(
              (save) =>
                save`INSERT INTO context_sources (project_id, root_thread_id, scope, name, slug) VALUES (${project.id}, ${root}, 'lineage', 'Uploads', 'uploads')`,
            ),
          ).rejects.toMatchObject({ constraint_name: "context_sources_exactly_one_scope" });
          await tx`DELETE FROM threads WHERE id = ${root}`;
          expect(await tx`SELECT id FROM context_sources WHERE id = ${source.id}`).toEqual([
            { id: source.id },
          ]);
          await tx`DELETE FROM users WHERE id = ${user.id}`;
        });
      } finally {
        await target.end();
      }
    });
    it("applies the post-migrate FIFO function with replay-safe debits", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      try {
        await target.begin(async (tx) => {
          const [user] = await tx`INSERT INTO users (external_id, email)
            VALUES ('baseline-functions', 'baseline-functions@example.test') RETURNING id`;
          await tx`INSERT INTO credit_lots (user_id, original_amount_millicredits, remaining_millicredits, source_type, grant_reason)
            VALUES (${user.id}, 100, 100, 'grant', 'baseline-probe')`;
          const first =
            await tx`SELECT * FROM consume_credit_lots_fifo(${user.id}::uuid, 30, gen_random_uuid(), 'baseline-usage')`;
          expect(first).toEqual([
            {
              remaining_balance: "70",
              went_negative: false,
              consumption_group_id: expect.any(String),
            },
          ]);
          expect(
            await tx`SELECT * FROM consume_credit_lots_fifo(${user.id}::uuid, 30, gen_random_uuid(), 'baseline-usage')`,
          ).toEqual(first);
          expect(
            await tx`SELECT amount_millicredits FROM credit_transactions WHERE user_id = ${user.id}`,
          ).toEqual([{ amount_millicredits: "-30" }]);
          await tx`DELETE FROM users WHERE id = ${user.id}`;
        });
      } finally {
        await target.end();
      }
    });

    it("preserves representative rows and backfills dead price fields through 0113 and 0114", async () => {
      await upgradeWithRows(
        databaseUrl ?? "",
        "0113_drop_dead_price_fields",
        async (target) => {
          await target.begin(async (tx) => {
            await tx`INSERT INTO users (id, external_id, email)
              VALUES ('00000000-0000-4000-8000-000000000701', 'migration-user', 'migration-user@test.invalid')`;
            await tx`INSERT INTO projects (id, user_id, name, slug)
              VALUES ('00000000-0000-4000-8000-000000000702', '00000000-0000-4000-8000-000000000701', 'Migration project', 'migration-project')`;
            await tx`INSERT INTO works (id, project_id, created_by_user_id, name, handle)
              VALUES ('00000000-0000-4000-8000-000000000703', '00000000-0000-4000-8000-000000000702', '00000000-0000-4000-8000-000000000701', 'Migration work', 'w1')`;
            await tx`INSERT INTO threads (id, root_thread_id, project_id, created_by_user_id, ref)
              VALUES ('00000000-0000-4000-8000-000000000704', '00000000-0000-4000-8000-000000000704', '00000000-0000-4000-8000-000000000702', '00000000-0000-4000-8000-000000000701', 'c701')`;
            await tx`INSERT INTO turns (id, thread_id, position, role, origin, status)
              VALUES ('00000000-0000-4000-8000-000000000705', '00000000-0000-4000-8000-000000000704', 1, 'user', 'writer', 'complete')`;
            await tx`INSERT INTO turn_blocks (id, turn_id, block_type, sequence, content, model_text)
              VALUES ('00000000-0000-4000-8000-000000000706', '00000000-0000-4000-8000-000000000705', 'text', 0, '{"text":"stored manuscript"}', 'stored manuscript')`;
            // One response per retired value. App-written rows with an ID have null metadata, so the
            // second row is the shape the backfill must not lose.
            const retired = [
              ["provider_reported", "uncached", "gen-1", { audit: true }],
              ["configured_rate", "reusable_prefix", "gen-2", null],
              ["computed", "ttl_expired", null, null],
            ] as const;
            for (const [index, [source, reason, requestId, metadata]] of retired.entries()) {
              await tx`INSERT INTO model_responses (id, turn_id, sequence, provider, model, provider_request_id,
                  price_source, predicted_cache_state, predicted_cache_reason, request_message_count, response_metadata)
                VALUES (${`00000000-0000-4000-8000-00000000072${index}`}, '00000000-0000-4000-8000-000000000705', ${index},
                  'p', 'm', ${requestId}, ${source}, 'cold', ${reason}, 0, ${metadata ? tx.json(metadata) : null})`;
            }
          });
        },
        async (target) => {
          expect(await target`SELECT id, email FROM users`).toEqual([
            { id: "00000000-0000-4000-8000-000000000701", email: "migration-user@test.invalid" },
          ]);
          expect(await target`SELECT id, name, slug FROM projects`).toEqual([
            {
              id: "00000000-0000-4000-8000-000000000702",
              name: "Migration project",
              slug: "migration-project",
            },
          ]);
          expect(await target`SELECT id, name, handle FROM works`).toEqual([
            {
              id: "00000000-0000-4000-8000-000000000703",
              name: "Migration work",
              handle: "w1",
            },
          ]);
          expect(await target`SELECT id, ref FROM threads`).toEqual([
            { id: "00000000-0000-4000-8000-000000000704", ref: "c701" },
          ]);
          expect(await target`SELECT id, status FROM turns`).toEqual([
            { id: "00000000-0000-4000-8000-000000000705", status: "complete" },
          ]);
          expect(await target`SELECT id, model_text FROM turn_blocks`).toEqual([
            { id: "00000000-0000-4000-8000-000000000706", model_text: "stored manuscript" },
          ]);
          expect(
            await target`SELECT price_source, predicted_cache_reason, response_metadata
              FROM model_responses ORDER BY sequence`,
          ).toEqual([
            {
              price_source: "computed",
              predicted_cache_reason: "ttl_unknown",
              response_metadata: { audit: true, providerRequestId: "gen-1" },
            },
            {
              price_source: "computed",
              predicted_cache_reason: "reusable_prefix",
              response_metadata: { providerRequestId: "gen-2" },
            },
            {
              price_source: "computed",
              predicted_cache_reason: "ttl_expired",
              response_metadata: null,
            },
          ]);
          expect(
            await target`SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_name = 'model_responses' AND column_name = 'provider_request_id'`,
          ).toEqual([{ n: 0 }]);
        },
      );
    });

    it("moves No Work branches to their lineage through 0131 and recounts pending documents", async () => {
      const ids = (n: number) => `00000000-0000-4000-8000-0000000008${String(n).padStart(2, "0")}`;
      const user = ids(1);
      // One project per case; each has its own No Work row, and a branch per ids() below.
      const cases = ["empty", "one", "several", "writer", "journal"] as const;
      const project = (i: number) => ids(10 + i);
      const noWork = (i: number) => ids(20 + i);
      const branch = (i: number) => ids(30 + i);
      const doc = (i: number, k: number) => ids(40 + i * 3 + k);
      const thread = (i: number, k: number) => ids(60 + i * 3 + k);
      await upgradeWithRows(
        databaseUrl ?? "",
        "0131_lineage_owned_drafts",
        async (target) => {
          await target`INSERT INTO users (id, external_id, email)
            VALUES (${user}, 'lineage-migration', 'lineage-migration@test.invalid')`;
          for (const [i, name] of cases.entries()) {
            await target`INSERT INTO projects (id, user_id, name, slug) VALUES (${project(i)}, ${user}, ${name}, ${name})`;
            await target`INSERT INTO works (id, project_id, created_by_user_id, name, is_no_work, pending_document_count)
              VALUES (${noWork(i)}, ${project(i)}, ${user}, 'No Work', true, 5)`;
            const [source] = await target`INSERT INTO context_sources (project_id, name, slug)
              VALUES (${project(i)}, 'Project', 'project') RETURNING id`;
            // Threads: [0] a lineage root, [1] its fork, [2] a second lineage root.
            await target`INSERT INTO threads (id, root_thread_id, project_id, created_by_user_id, ref)
              VALUES (${thread(i, 0)}, ${thread(i, 0)}, ${project(i)}, ${user}, ${`c${i}0`}),
                     (${thread(i, 1)}, ${thread(i, 0)}, ${project(i)}, ${user}, ${`c${i}1`}),
                     (${thread(i, 2)}, ${thread(i, 2)}, ${project(i)}, ${user}, ${`c${i}2`})`;
            for (const k of [0, 1])
              await target`INSERT INTO documents (id, context_source_id, name, hidden)
                VALUES (${doc(i, k)}, ${source.id}, ${`d${k}`}, true)`;
            await target`INSERT INTO branches (id, project_id, origin_work_id, created_by)
              VALUES (${branch(i)}, ${project(i)}, ${noWork(i)}, ${user})`;
          }
          const created = (i: number, k: number, by: string | null) =>
            target`INSERT INTO branch_tree_changes (branch_id, node_kind, node_id, created, created_thread_id)
              VALUES (${branch(i)}, 'document', ${doc(i, k)}, true, ${by})`;
          await created(1, 0, thread(1, 1));
          await created(2, 0, thread(2, 0));
          await created(2, 1, thread(2, 2));
          await created(3, 0, null);
          await target`INSERT INTO document_drafts (id, branch_id, document_id, kind, state, state_vector, has_effect)
            VALUES ('draft-journal', ${branch(4)}, ${doc(4, 0)}, 'work_draft', ''::bytea, ''::bytea, true)`;
          await target`INSERT INTO draft_write_journal (draft_id, thread_id, update_data)
            VALUES ('draft-journal', ${thread(4, 2)}, ''::bytea)`;
        },
        async (target) => {
          const rows =
            await target`SELECT id, status, origin_work_id, origin_root_thread_id, pending_document_count
            FROM branches ORDER BY id`;
          expect(
            rows.map((row) => [
              row.status,
              row.origin_work_id,
              row.origin_root_thread_id,
              row.pending_document_count,
            ]),
          ).toEqual([
            ["closed", noWork(0), null, 0],
            ["active", null, thread(1, 0), 1],
            ["active", noWork(2), null, 2],
            ["active", noWork(3), null, 1],
            ["active", null, thread(4, 2), 1],
          ]);
          // The Work total is the sum of its still-owned active branches.
          expect(
            (await target`SELECT pending_document_count FROM works ORDER BY id`).map(
              (row) => row.pending_document_count,
            ),
          ).toEqual([0, 0, 2, 1, 0]);
          expect(
            await target`SELECT count(*)::int AS n FROM branches WHERE status = 'active' AND origin_work_id IS NULL AND origin_root_thread_id IS NULL`,
          ).toEqual([{ n: 0 }]);
        },
      );
    });
  });
}
