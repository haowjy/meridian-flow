/**
 * Real-Postgres contracts for migration refusal, catch-up, and serialization.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - single-snapshot migration bytes recorded before lock acquisition (packages/database/.context/CONTEXT.md#baseline-inputs)
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_ADVISORY_LOCK_ID, runMigrations } from "./migration-runner";
import { disposableTestDatabaseTarget } from "./test-db-lifecycle";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" && Boolean(databaseUrl);

async function writeBaseline(directory: string, sql: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "0000_baseline.sql"), sql);
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
  // The runner's contracts change schemas, so they run on a database of their own, never the worker's.
  const scratchTarget = disposableTestDatabaseTarget(
    databaseUrl ?? "",
    `migration_runner_test_${process.pid}_${Date.now()}`,
  );
  const scratchName = scratchTarget.databaseName;
  const adminUrl = new URL(databaseUrl ?? "");
  adminUrl.pathname = "/postgres";
  const scratchUrl = scratchTarget.databaseUrl;
  const admin = postgres(adminUrl.toString(), { max: 1 });
  let sql: postgres.Sql;
  let temporaryRoot: string;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "meridian-migration-runner-"));
    await admin.unsafe(`CREATE DATABASE "${scratchName}"`);
    sql = postgres(scratchUrl, { max: 1 });
  });

  beforeEach(async () => {
    await sql`DROP SCHEMA public CASCADE`;
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await sql`CREATE SCHEMA public`;
  });

  afterAll(async () => {
    try {
      await sql?.end();
      if (!scratchTarget.managedTemplate)
        await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    } finally {
      await admin.end();
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("executes and records the snapshot read before waiting on the lock", async () => {
    const directory = path.join(temporaryRoot, "snapshot");
    const original = {
      sql: "\uFEFFCREATE TABLE public.snapshot_before (id int);\r\n",
    };
    await writeBaseline(directory, original.sql);
    await sql`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
    const run = runMigrations({ databaseUrl: scratchUrl, migrationsDirectory: directory });
    let waitError: unknown;
    try {
      await waitForAdvisoryLockWaiters(sql, 1);
      await writeBaseline(directory, "CREATE TABLE public.snapshot_after (id int);");
    } catch (error) {
      waitError = error;
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
    }
    const [result] = await Promise.allSettled([run]);
    if (waitError) throw waitError;
    if (result?.status === "rejected") throw result.reason;
    expect(
      await sql`SELECT to_regclass('public.snapshot_before') IS NOT NULL AS before,
      to_regclass('public.snapshot_after') IS NOT NULL AS after`,
    ).toEqual([{ before: true, after: false }]);
    expect(await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations`).toEqual([
      { hash: createHash("sha256").update(original.sql).digest("hex"), created_at: "0" },
    ]);
  });
});
