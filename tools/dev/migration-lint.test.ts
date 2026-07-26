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

async function lintMigration(name: string, sql: string) {
  const directory = await mkdtemp(join(tmpdir(), "migration-lint-"));
  directories.push(directory);
  const migration = join(directory, name);
  await writeFile(migration, sql);
  try {
    const result = await run("pnpm", ["exec", "tsx", "tools/dev/migration-lint.ts", migration]);
    return { exitCode: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { exitCode: result.code, output: result.stdout + result.stderr };
  }
}

describe("migration lint", () => {
  it("enforces populated-row safety from the unreleased migration tail", async () => {
    const unreleased = await lintMigration(
      "0060_unsafe.sql",
      'ALTER TABLE "publications" ADD COLUMN "generation" integer NOT NULL;',
    );
    const released = await lintMigration(
      "0059_unsafe.sql",
      'ALTER TABLE "publications" ADD COLUMN "generation" integer NOT NULL;',
    );

    expect(unreleased.exitCode).toBe(1);
    expect(unreleased.output).toContain("[ADD_NOT_NULL_WITHOUT_DEFAULT]");
    expect(released.exitCode).toBe(0);
    expect(released.output).toContain("No issues found");
  });

  it("rejects a new NOT NULL column that cannot be added to populated rows", async () => {
    const result = await lintMigration(
      "0067_unsafe.sql",
      'ALTER TABLE "publications" ADD COLUMN "generation" integer NOT NULL;',
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("[ADD_NOT_NULL_WITHOUT_DEFAULT]");
  });

  it("accepts a nullable add followed by a backfill and NOT NULL constraint", async () => {
    const result = await lintMigration(
      "0067_safe.sql",
      [
        'ALTER TABLE "publications" ADD COLUMN "generation" integer;',
        'UPDATE "publications" SET "generation" = 1; -- migration-lint: skip UPDATE_WITHOUT_WHERE',
        'ALTER TABLE "publications" ALTER COLUMN "generation" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE',
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No issues found");
  });
});
