/**
 * Phase 4 (design §8.4, R6): `0064_has_effect_watermark.sql` adds `has_effect_revision bigint
 * NOT NULL DEFAULT -1` as a catalog change under `SET LOCAL lock_timeout = '2s'`, with no
 * backfill and no CHECK, so an old server's creator keeps inserting during the rollout.
 *
 * On its own scratch database, migrated to the migration before 0064 and seeded with document drafts as
 * the pre-phase-4 creator wrote them:
 * 1. a reader holding `document_branches` open: 0064 gives up within its lock timeout
 *    (`55P03`) instead of queueing readers behind it, and a reader started meanwhile completes;
 * 2. released: 0064 applies while a reader loops, no read waits past the timeout, the table
 *    is not rewritten (`relfilenode` unchanged) and every existing row reads `-1`;
 * 3. the old creator's insert (no baseline, no watermark) succeeds after 0064 and
 *    the historical stale-effect predicate selects it.
 *
 * Negative control on `586e58ae1e`: there is no 0064.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import {
  dropDatabaseForUrl,
  ensureDatabaseForUrl,
  LOCAL_DEV_POSTGRES_PORT,
} from "../../../dev/lib/dev-db.ts";
import { resolveCurrentRepoRoot } from "../../../dev/lib/dev-env.ts";
import { runMigrations } from "../../../dev/lib/migration-runner.ts";
import {
  gate,
  observe,
  openHarness,
  type Probe,
  paragraphDoc,
  SCRATCH_PREFIX,
  settled,
  Y,
} from "./harness.mts";
import { percentiles } from "./phase4.mts";

const MIGRATIONS = resolve(resolveCurrentRepoRoot(), "packages/database/src/migrations");
const LOCK_TIMEOUT_MS = 2_000;

/** The 0064 file and a copy of the migration directory that stops just before it. */
function migrationsBefore0064() {
  const file = readdirSync(MIGRATIONS).find((name) => /^0064_.*\.sql$/.test(name));
  if (!file || !readFileSync(join(MIGRATIONS, file), "utf8").includes("has_effect_revision"))
    throw new Error("No 0064 migration adding has_effect_revision");
  const tag = file.replace(/\.sql$/, "");
  const directory = mkdtempSync(join(tmpdir(), "lfd-probe-migrations-"));
  cpSync(MIGRATIONS, directory, { recursive: true });
  const journalPath = join(directory, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  const nextEntry = journal.entries[index];
  if (!nextEntry) throw new Error("Missing 0064 journal entry");
  for (const entry of journal.entries.slice(index)) rmSync(join(directory, `${entry.tag}.sql`));
  journal.entries = journal.entries.slice(0, index);
  writeFileSync(journalPath, JSON.stringify(journal));
  return {
    directory,
    upgrade() {
      // The probe measures 0064, not later migrations or the 0068 vocabulary rename.
      writeFileSync(join(directory, file), readFileSync(join(MIGRATIONS, file)));
      journal.entries.push(nextEntry);
      writeFileSync(journalPath, JSON.stringify(journal));
    },
  };
}

async function migrateQuietly(databaseUrl: string, migrationsDirectory: string) {
  const log = console.log;
  console.log = () => {};
  try {
    await runMigrations({ databaseUrl, migrationsDirectory });
  } finally {
    console.log = log;
  }
}

export const migrationOnline: Probe = {
  name: "migration-online",
  decision: "D28 (§8.4 R6)",
  expected:
    "a held reader makes 0064 give up within 2 s; unheld it applies with no table rewrite, every row -1, no read waits past the timeout; the old creator's insert succeeds and is stale",
  async run() {
    const before = migrationsBefore0064();
    const name = `${SCRATCH_PREFIX}mig_${process.pid}_${Date.now().toString(36)}`;
    const url = `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DEV_POSTGRES_PORT}/${name}`;
    await ensureDatabaseForUrl(url);
    const sql = postgres(url, { max: 4 });
    let opened: Awaited<ReturnType<typeof openHarness>> | undefined;
    try {
      await migrateQuietly(url, before.directory);
      const harness = await openHarness(url);
      opened = harness;
      // The review's seed, as the pre-phase-4 creator wrote it: no baseline, revision 0.
      const workId = randomUUID();
      const branchId = randomUUID();
      await sql`insert into works(id,project_id,created_by_user_id,name,slug)
        values (${workId},${harness.ids.project},${harness.ids.user},'migration','migration')`;
      // These are historical 0063 names: the current adapters target the renamed schema.
      await sql`insert into drafts(id,project_id,origin_work_id,created_by)
        values (${branchId},${harness.ids.project},${workId},${harness.ids.user})`;
      const insertOldCreatorRow = async () => {
        const { documentId } = await harness.seedDocument("migration");
        const seed = paragraphDoc("Base");
        const id = `branch_${randomUUID()}`;
        await sql`insert into document_branches (id, document_id, kind, draft_id, status, state, state_vector, revision)
          values (${id}, ${documentId}, 'work_draft', ${branchId}, 'active',
            ${Buffer.from(Y.encodeStateAsUpdate(seed))}, ${Buffer.from(Y.encodeStateVector(seed))}, 0)`;
        seed.destroy();
        return id;
      };
      for (let index = 0; index < 20; index += 1) await insertOldCreatorRow();
      const [{ relfilenode: fileBefore } = { relfilenode: 0 }] = await sql<
        { relfilenode: number }[]
      >`
        select relfilenode from pg_class where relname = 'document_branches'`;

      before.upgrade();

      // 1. A reader holds the table: 0064 must give up, not queue readers behind it.
      const holding = gate();
      const release = gate();
      const holder = sql.begin(async (tx) => {
        await tx`select count(*) from document_branches`;
        holding.open();
        await release.wait;
      });
      await holding.wait;
      const attemptStarted = performance.now();
      const attempt = settled(migrateQuietly(url, before.directory));
      const readerStarted = performance.now();
      await sql`select count(*) from document_branches`;
      const readerMs = Math.round(performance.now() - readerStarted);
      const refused = await attempt;
      const attemptMs = Math.round(performance.now() - attemptStarted);
      release.open();
      await holder;
      const [column] = await sql`select 1 from information_schema.columns
        where table_name = 'document_branches' and column_name = 'has_effect_revision'`;
      observe("1 held", { refused, attemptMs, readerMs, applied: Boolean(column) });
      assert.equal(refused.ok, false, "0064 gives up while a reader holds the table");
      assert.ok(attemptMs < LOCK_TIMEOUT_MS + 1_000, `within its lock timeout: ${attemptMs} ms`);
      assert.ok(
        readerMs < LOCK_TIMEOUT_MS + 500,
        `a reader started meanwhile completes: ${readerMs} ms`,
      );
      assert.equal(column, undefined, "nothing applied");

      // 2. Unheld, under a looping reader.
      const reads: number[] = [];
      let reading = true;
      const reader = (async () => {
        while (reading) {
          const started = performance.now();
          await sql`select count(*) from document_branches`;
          reads.push(performance.now() - started);
        }
      })();
      const migrated = performance.now();
      await migrateQuietly(url, before.directory);
      const migrateMs = Math.round(performance.now() - migrated);
      reading = false;
      await reader;
      const [{ relfilenode: fileAfter } = { relfilenode: 0 }] = await sql<
        { relfilenode: number }[]
      >`
        select relfilenode from pg_class where relname = 'document_branches'`;
      const watermarks = await sql<{ watermark: string; n: number }[]>`
        select has_effect_revision::text as watermark, count(*)::int as n from document_branches group by 1`;
      const readLatency = percentiles(reads);
      observe("2 applied", {
        migrateMs,
        readLatency,
        rewritten: fileBefore !== fileAfter,
        watermarks,
      });
      assert.equal(fileAfter, fileBefore, "a catalog change: the table is not rewritten");
      assert.deepEqual(
        [...watermarks],
        [{ watermark: "-1", n: 20 }],
        "every existing row is stale",
      );
      assert.ok(readLatency.max < LOCK_TIMEOUT_MS, "no read waited past the lock timeout");

      // 3. An old server's creator during the rollout.
      const oldRow = await insertOldCreatorRow();
      const stale = await sql<{ id: string }[]>`select id from document_branches
        where kind = 'work_draft' and status = 'active' and has_effect_revision < revision
        order by updated_at, id limit 50`;
      const selected = stale.some((row) => row.id === oldRow);
      observe("3 old creator", { inserted: oldRow.slice(0, 20), selected, stale: stale.length });
      assert.ok(selected, "the old creator's row is selected by the stale-effect predicate");
    } finally {
      await opened?.close();
      await sql.end();
      rmSync(before.directory, { recursive: true, force: true });
      await dropDatabaseForUrl(url, []);
    }
  },
};
