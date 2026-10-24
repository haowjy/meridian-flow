/** Authoring-gate coverage for unsafe generated migration patterns.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Migration authoring lint heuristics and severity policy
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { lintMigrationFile, migrationLintStatus } from "./migration-lint";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function writeMigration(name: string, sql: string) {
  const directory = await mkdtemp(join(tmpdir(), "migration-lint-"));
  directories.push(directory);
  const file = join(directory, name);
  await writeFile(file, sql);
  return file;
}

async function lint(name: string, sql: string, strict = false) {
  const file = await writeMigration(name, sql);
  const findings = lintMigrationFile(file);
  return {
    exitCode: migrationLintStatus(findings, strict),
    rules: findings.map((finding) => finding.ruleId),
  };
}

describe("migration lint", () => {
  it("enforces populated-row safety immediately after the baseline", async () => {
    const sql = 'ALTER TABLE "publications" ADD COLUMN "generation" integer NOT NULL;';
    const additive = await lint("0001_unsafe.sql", sql);
    const baseline = await lint("0000_baseline.sql", sql);

    expect(additive.exitCode).toBe(1);
    expect(additive.rules).toContain("ADD_NOT_NULL_WITHOUT_DEFAULT");
    expect(baseline).toEqual({ exitCode: 0, rules: [] });
  });

  it("requires a bounded lock for retired columns, without requiring an old server version", async () => {
    const drop = 'ALTER TABLE "obsolete_preferences" DROP COLUMN "unused";';
    const unsafe = await lint("0001_retire.sql", drop, true);
    expect(unsafe.exitCode).toBe(1);
    expect(unsafe.rules).toContain("DROP_COLUMN");
    expect(
      (await lint("0001_retire.sql", `SET LOCAL lock_timeout = '2s';\n${drop}`, true)).exitCode,
    ).toBe(0);
    expect(
      (await lint("0001_retire.sql", `${drop}\nSET LOCAL lock_timeout = '2s';`, true)).exitCode,
    ).toBe(1);
    // A commented timeout or a zero timeout must not bless unbounded locking.
    for (const prefix of [
      "-- SET LOCAL lock_timeout = '2s';\n",
      "SET LOCAL lock_timeout = '0';\n",
      "SET LOCAL lock_timeout = '20s';\n",
      "-- migration: no-transaction\nSET LOCAL lock_timeout = '2s';\n",
    ]) {
      expect((await lint("0001_retire.sql", prefix + drop, true)).exitCode).toBe(1);
    }
  });

  it("invalidates a bounded timeout after overrides or transaction boundaries", async () => {
    const drop = "ALTER TABLE obsolete DROP COLUMN unused;";
    for (const override of [
      "RESET lock_timeout;",
      "RESET ALL;",
      "SET lock_timeout = '0';",
      "SET LOCAL lock_timeout TO '0';",
      "SET SESSION lock_timeout TO DEFAULT;",
      "COMMIT;",
      "ROLLBACK;",
      "END;",
      "SAVEPOINT before_timeout; ROLLBACK TO before_timeout;",
    ]) {
      const result = await lint(
        "0001_override.sql",
        `SET LOCAL lock_timeout = '2s';\n${override}\n${drop}`,
        true,
      );
      expect(result.exitCode, override).toBe(1);
      expect(result.rules, override).toContain("DROP_COLUMN");
    }
    expect(
      (await lint("0001_safe.sql", `SET LOCAL lock_timeout TO '3s';\n${drop}`, true)).exitCode,
    ).toBe(0);
  });

  it("accepts a nullable add followed by a backfill and NOT NULL constraint", async () => {
    const result = await lint(
      "0001_safe.sql",
      [
        'ALTER TABLE "publications" ADD COLUMN "generation" integer;',
        'UPDATE "publications" SET "generation" = 1; -- migration-lint: skip UPDATE_WITHOUT_WHERE',
        'ALTER TABLE "publications" ALTER COLUMN "generation" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE',
      ].join("\n"),
    );

    expect(result).toEqual({ exitCode: 0, rules: [] });
  });

  it("requires a marker, IF NOT EXISTS, and isolated concurrent chunks", async () => {
    const build =
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS public."events_id" ON "events" ("id");';
    for (const prefix of ["", "\n-- migration: no-transaction\n"]) {
      const result = await lint("0001_index.sql", prefix + build);
      expect(result.rules).toContain("CONCURRENTLY_IN_TRANSACTION");
    }
    const missingGuard = await lint(
      "0001_index.sql",
      `-- migration: no-transaction\n${build.replace("IF NOT EXISTS ", "")}`,
    );
    expect(missingGuard.rules).toContain("CONCURRENT_INDEX_IF_NOT_EXISTS");
    const shared = await lint(
      "0001_index.sql",
      `-- migration: no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS events_id;\n${build}`,
    );
    expect(shared.rules).toContain("CONCURRENTLY_SHARED_CHUNK");
    for (const marker of [
      "-- migration: no-transaction\n",
      "-- migration: no-transaction\r\n",
      "\uFEFF-- migration: no-transaction\n",
    ]) {
      const safe = await lint(
        "0001_index.sql",
        `${marker}DROP INDEX CONCURRENTLY IF EXISTS events_id;\n--> statement-breakpoint\n${build}`,
        true,
      );
      expect(safe.exitCode).toBe(0);
    }
  });

  it("checks each multiline ALTER clause and recognizes all index identifiers", async () => {
    const mixed = await lint(
      "0001_checks.sql",
      'ALTER TABLE public.events\nADD CHECK (id > 0),\nADD CONSTRAINT "safe" CHECK (id < 10) NOT VALID,\nADD CONSTRAINT public.unsafe CHECK (id <> 5);',
      true,
    );
    expect(mixed.rules.filter((rule) => rule === "ADD_CHECK_NOT_VALID")).toHaveLength(2);
    for (const name of ["events_id", '"events_id"', "public.events_id", '"public"."events_id"']) {
      const result = await lint("0001_index.sql", `CREATE INDEX ${name} ON events (id);`);
      expect(result.rules).toContain("INDEX_NOT_CONCURRENTLY");
    }
  });

  it("warns about offline checks and drops while preserving baseline and skip policy", async () => {
    const unsafe = [
      'ALTER TABLE "events" ADD CONSTRAINT "positive" CHECK ("id" > 0);',
      'DROP INDEX "events_id";',
    ].join("\n");
    const warnings = await lint("0001_checks.sql", unsafe);
    expect(warnings.exitCode).toBe(0);
    expect(warnings.rules).toEqual(
      expect.arrayContaining(["ADD_CHECK_NOT_VALID", "DROP_INDEX_NOT_CONCURRENTLY"]),
    );
    expect((await lint("0001_checks.sql", unsafe, true)).exitCode).toBe(1);
    expect((await lint("0000_baseline.sql", unsafe, true)).exitCode).toBe(0);
    const safe = await lint(
      "0001_checks.sql",
      'ALTER TABLE "events" ADD CONSTRAINT "positive"\nCHECK ("id" > 0) NOT VALID;',
      true,
    );
    expect(safe.exitCode).toBe(0);
    const unquoted = await lint(
      "0001_checks.sql",
      "ALTER TABLE events ADD CONSTRAINT positive\nCHECK (id > 0)",
    );
    expect(unquoted.rules).toContain("ADD_CHECK_NOT_VALID");
    const skipped = await lint(
      "0001_skip.sql",
      'DROP INDEX "events_id"; -- migration-lint: skip DROP_INDEX_NOT_CONCURRENTLY (pre-launch)',
      true,
    );
    expect(skipped.exitCode).toBe(0);
  });

  it("reports rule ids and the clean result through the CLI", async () => {
    const sql = 'ALTER TABLE "publications" ADD COLUMN "generation" integer NOT NULL;';
    const [unsafe, baseline] = await Promise.all([
      writeMigration("0001_unsafe.sql", sql),
      writeMigration("0000_baseline.sql", sql),
    ]);
    const [failed, clean] = await Promise.all([
      run(process.execPath, ["--import", "tsx", "tools/dev/migration-lint.ts", unsafe]).then(
        (result) => ({ exitCode: 0, output: result.stdout + result.stderr }),
        (error: { code: number; stdout: string; stderr: string }) => ({
          exitCode: error.code,
          output: error.stdout + error.stderr,
        }),
      ),
      run(process.execPath, ["--import", "tsx", "tools/dev/migration-lint.ts", baseline]).then(
        (result) => ({ exitCode: 0, output: result.stdout + result.stderr }),
        (error: { code: number; stdout: string; stderr: string }) => ({
          exitCode: error.code,
          output: error.stdout + error.stderr,
        }),
      ),
    ]);

    expect(failed.exitCode).toBe(1);
    expect(failed.output).toContain("[ADD_NOT_NULL_WITHOUT_DEFAULT]");
    expect(clean.exitCode).toBe(0);
    expect(clean.output).toContain("No issues found");
  });
});
