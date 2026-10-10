/** Authoring-gate coverage for unsafe generated migration patterns. */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function lintMigration(name: string, sql: string, ...options: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "migration-lint-"));
  directories.push(directory);
  const migration = join(directory, name);
  await writeFile(migration, sql);
  try {
    const result = await run(process.execPath, [
      "--import",
      "tsx",
      "tools/dev/migration-lint.ts",
      migration,
      ...options,
    ]);
    return { exitCode: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { exitCode: result.code, output: result.stdout + result.stderr };
  }
}

// Each case launches several real CLI processes alongside the full unit gate.
describe("migration lint", { timeout: 15_000 }, () => {
  it("enforces populated-row safety immediately after the baseline", async () => {
    const additive = await lintMigration(
      "0001_unsafe.sql",
      'ALTER TABLE "publications" ADD COLUMN "generation" integer NOT NULL;',
    );
    const baseline = await lintMigration(
      "0000_baseline.sql",
      'ALTER TABLE "publications" ADD COLUMN "generation" integer NOT NULL;',
    );

    expect(additive.exitCode).toBe(1);
    expect(additive.output).toContain("[ADD_NOT_NULL_WITHOUT_DEFAULT]");
    expect(baseline.exitCode).toBe(0);
    expect(baseline.output).toContain("No issues found");
  });

  it("requires a bounded lock for retired columns, without requiring an old server version", async () => {
    const drop = 'ALTER TABLE "obsolete_preferences" DROP COLUMN "unused";';
    const unsafe = await lintMigration("0001_retire.sql", drop, "--strict");
    expect(unsafe.exitCode).toBe(1);
    expect(unsafe.output).toContain("[DROP_COLUMN]");
    const safe = await lintMigration(
      "0001_retire.sql",
      `SET LOCAL lock_timeout = '2s';\n${drop}`,
      "--strict",
    );
    expect(safe.exitCode).toBe(0);
    expect(
      (
        await lintMigration(
          "0001_retire.sql",
          `${drop}\nSET LOCAL lock_timeout = '2s';`,
          "--strict",
        )
      ).exitCode,
    ).toBe(1);
    // A commented timeout or a zero timeout must not bless unbounded locking.
    for (const prefix of [
      "-- SET LOCAL lock_timeout = '2s';\n",
      "SET LOCAL lock_timeout = '0';\n",
      "SET LOCAL lock_timeout = '20s';\n",
      "-- migration: no-transaction\nSET LOCAL lock_timeout = '2s';\n",
    ]) {
      expect((await lintMigration("0001_retire.sql", prefix + drop, "--strict")).exitCode).toBe(1);
    }
  });

  it("accepts a nullable add followed by a backfill and NOT NULL constraint", async () => {
    const result = await lintMigration(
      "0001_safe.sql",
      [
        'ALTER TABLE "publications" ADD COLUMN "generation" integer;',
        'UPDATE "publications" SET "generation" = 1; -- migration-lint: skip UPDATE_WITHOUT_WHERE',
        'ALTER TABLE "publications" ALTER COLUMN "generation" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE',
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No issues found");
  });

  it("requires a marker, IF NOT EXISTS, and isolated concurrent chunks", async () => {
    const build =
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS public."events_id" ON "events" ("id");';
    for (const prefix of ["", "\n-- migration: no-transaction\n"]) {
      const result = await lintMigration("0001_index.sql", prefix + build);
      expect(result.output).toContain("[CONCURRENTLY_IN_TRANSACTION]");
    }
    const missingGuard = await lintMigration(
      "0001_index.sql",
      `-- migration: no-transaction\n${build.replace("IF NOT EXISTS ", "")}`,
    );
    expect(missingGuard.output).toContain("[CONCURRENT_INDEX_IF_NOT_EXISTS]");
    const shared = await lintMigration(
      "0001_index.sql",
      `-- migration: no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS events_id;\n${build}`,
    );
    expect(shared.output).toContain("[CONCURRENTLY_SHARED_CHUNK]");
    for (const marker of [
      "-- migration: no-transaction\n",
      "-- migration: no-transaction\r\n",
      "\uFEFF-- migration: no-transaction\n",
    ]) {
      const safe = await lintMigration(
        "0001_index.sql",
        `${marker}DROP INDEX CONCURRENTLY IF EXISTS events_id;\n--> statement-breakpoint\n${build}`,
        "--strict",
      );
      expect(safe.exitCode).toBe(0);
    }
  });

  it("checks each multiline ALTER clause and recognizes all index identifiers", async () => {
    const mixed = await lintMigration(
      "0001_checks.sql",
      'ALTER TABLE public.events\nADD CHECK (id > 0),\nADD CONSTRAINT "safe" CHECK (id < 10) NOT VALID,\nADD CONSTRAINT public.unsafe CHECK (id <> 5);',
      "--strict",
    );
    expect(mixed.output.match(/\[ADD_CHECK_NOT_VALID\]/g)).toHaveLength(2);
    for (const name of ["events_id", '"events_id"', "public.events_id", '"public"."events_id"']) {
      const result = await lintMigration("0001_index.sql", `CREATE INDEX ${name} ON events (id);`);
      expect(result.output).toContain("[INDEX_NOT_CONCURRENTLY]");
    }
  });

  it("warns about offline checks and drops while preserving baseline and skip policy", async () => {
    const unsafe = [
      'ALTER TABLE "events" ADD CONSTRAINT "positive" CHECK ("id" > 0);',
      'DROP INDEX "events_id";',
    ].join("\n");
    const warnings = await lintMigration("0001_checks.sql", unsafe);
    expect(warnings.exitCode).toBe(0);
    expect(warnings.output).toContain("[ADD_CHECK_NOT_VALID]");
    expect(warnings.output).toContain("[DROP_INDEX_NOT_CONCURRENTLY]");
    expect((await lintMigration("0001_checks.sql", unsafe, "--strict")).exitCode).toBe(1);
    expect((await lintMigration("0000_baseline.sql", unsafe, "--strict")).exitCode).toBe(0);
    const safe = await lintMigration(
      "0001_checks.sql",
      'ALTER TABLE "events" ADD CONSTRAINT "positive"\nCHECK ("id" > 0) NOT VALID;',
      "--strict",
    );
    expect(safe.exitCode).toBe(0);
    const unquoted = await lintMigration(
      "0001_checks.sql",
      "ALTER TABLE events ADD CONSTRAINT positive\nCHECK (id > 0)",
    );
    expect(unquoted.output).toContain("[ADD_CHECK_NOT_VALID]");
    const skipped = await lintMigration(
      "0001_skip.sql",
      'DROP INDEX "events_id"; -- migration-lint: skip DROP_INDEX_NOT_CONCURRENTLY (pre-launch)',
      "--strict",
    );
    expect(skipped.exitCode).toBe(0);
  });
});
