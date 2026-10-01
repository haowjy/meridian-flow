/** Real-Postgres contracts for migration refusal, catch-up, and serialization. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_ADVISORY_LOCK_ID, runMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" && Boolean(databaseUrl);
const savedPublic = "migration_runner_test_saved_public";
const savedDrizzle = "migration_runner_test_saved_drizzle";

interface TestMigration {
  tag: string;
  when: number;
  sql: string;
}

async function writeMigrations(
  directory: string,
  migrations: readonly TestMigration[],
  journalEntries = migrations.map((migration, idx) => ({
    idx,
    version: "7",
    when: migration.when,
    tag: migration.tag,
    breakpoints: true,
  })),
): Promise<void> {
  await mkdir(path.join(directory, "meta"), { recursive: true });
  await writeFile(
    path.join(directory, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: journalEntries }),
  );
  await Promise.all(
    migrations.map((migration) =>
      writeFile(path.join(directory, `${migration.tag}.sql`), migration.sql),
    ),
  );
}

async function waitForAdvisoryLockWaiters(
  sql: postgres.Sql,
  expected: number,
  timeoutMs = 5_000,
): Promise<void> {
  const lockClassId = Math.floor(MIGRATION_ADVISORY_LOCK_ID / 2 ** 32);
  const lockObjectId = MIGRATION_ADVISORY_LOCK_ID % 2 ** 32;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = ${lockClassId}
        AND objid = ${lockObjectId}
        AND objsubid = 1
        AND granted = false
    `;
    if (row?.count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} migration advisory lock waiters`);
}

describe.skipIf(!enabled)("migration runner (postgres)", () => {
  const sql = postgres(databaseUrl ?? "", { max: 1 });
  let temporaryRoot: string;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "meridian-migration-runner-"));
    await sql.begin(async (tx) => {
      await tx.unsafe(`ALTER SCHEMA public RENAME TO ${savedPublic}`);
      await tx.unsafe(`ALTER SCHEMA drizzle RENAME TO ${savedDrizzle}`);
      await tx`CREATE SCHEMA public`;
    });
  });

  afterAll(async () => {
    try {
      await sql.begin(async (tx) => {
        await tx`DROP SCHEMA IF EXISTS public CASCADE`;
        await tx`DROP SCHEMA IF EXISTS drizzle CASCADE`;
        await tx.unsafe(`ALTER SCHEMA ${savedPublic} RENAME TO public`);
        await tx.unsafe(`ALTER SCHEMA ${savedDrizzle} RENAME TO drizzle`);
      });
    } finally {
      await sql.end();
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("refuses without side effects, catches up in order, and serializes concurrent runs", async () => {
    const refusedDirectory = path.join(temporaryRoot, "refused");
    const refused = [
      { tag: "0000_refused", when: 100, sql: "CREATE TABLE public.refusal_effect (id int);" },
      { tag: "0001_duplicate_time", when: 100, sql: "SELECT 1;" },
    ];
    await writeMigrations(refusedDirectory, refused);

    await expect(
      runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: refusedDirectory }),
    ).rejects.toThrow("journal when 100 is duplicated");
    expect(await sql`SELECT to_regnamespace('drizzle') IS NOT NULL AS exists`).toEqual([
      { exists: false },
    ]);
    expect(await sql`SELECT to_regclass('public.refusal_effect') IS NOT NULL AS exists`).toEqual([
      { exists: false },
    ]);

    const catchUpDirectory = path.join(temporaryRoot, "catch-up");
    const first = {
      tag: "0000_first",
      when: 200,
      sql: "CREATE TABLE public.migration_events (position int PRIMARY KEY); INSERT INTO public.migration_events VALUES (1);",
    };
    const second = {
      tag: "0001_second",
      when: 300,
      sql: "INSERT INTO public.migration_events VALUES (2);",
    };
    await writeMigrations(catchUpDirectory, [first]);
    await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: catchUpDirectory });
    await writeMigrations(catchUpDirectory, [first, second]);
    await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: catchUpDirectory });
    expect(await sql`SELECT position FROM public.migration_events ORDER BY position`).toEqual([
      { position: 1 },
      { position: 2 },
    ]);
    expect(await sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual([
      { created_at: "200" },
      { created_at: "300" },
    ]);

    const appliedBeforeRefusal =
      await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    const effectsBeforeRefusal =
      await sql`SELECT position FROM public.migration_events ORDER BY position`;
    await writeMigrations(catchUpDirectory, [{ ...first, sql: `${first.sql}\nSELECT 1;` }, second]);
    await expect(
      runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: catchUpDirectory }),
    ).rejects.toThrow("migration 0000_first was edited after this database applied it");
    expect(
      await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
    ).toEqual(appliedBeforeRefusal);
    expect(await sql`SELECT position FROM public.migration_events ORDER BY position`).toEqual(
      effectsBeforeRefusal,
    );

    await sql`DROP SCHEMA public CASCADE`;
    await sql`DROP SCHEMA drizzle CASCADE`;
    await sql`CREATE SCHEMA public`;
    const concurrentDirectory = path.join(temporaryRoot, "concurrent");
    await writeMigrations(concurrentDirectory, [
      {
        tag: "0000_concurrent_first",
        when: 400,
        sql: "CREATE TABLE IF NOT EXISTS public.concurrent_events (position int); INSERT INTO public.concurrent_events VALUES (1);",
      },
      {
        tag: "0001_concurrent_second",
        when: 500,
        sql: "INSERT INTO public.concurrent_events VALUES (2);",
      },
    ]);
    await sql`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
    const concurrentRuns = [
      runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: concurrentDirectory }),
      runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: concurrentDirectory }),
    ];
    let waitError: unknown;
    try {
      await waitForAdvisoryLockWaiters(sql, 2);
    } catch (error) {
      waitError = error;
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
    }
    const concurrentResults = await Promise.allSettled(concurrentRuns);
    if (waitError) throw waitError;
    for (const result of concurrentResults) {
      if (result.status === "rejected") throw result.reason;
    }
    expect(await sql`SELECT position FROM public.concurrent_events ORDER BY position`).toEqual([
      { position: 1 },
      { position: 2 },
    ]);
    expect(await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`).toEqual([
      { count: 2 },
    ]);
  });
});
