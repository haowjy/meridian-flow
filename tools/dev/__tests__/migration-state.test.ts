import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeMigrationDrift,
  diffMigrations,
  readExpectedMigrationHashes,
} from "../lib/migration-state";

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content)).digest("hex");
}

describe("diffMigrations", () => {
  it("reports nothing when applied matches expected", () => {
    expect(diffMigrations(["a", "b"], ["a", "b"])).toEqual({ missing: [], unknown: [] });
  });

  it("reports missing when the DB is behind", () => {
    expect(diffMigrations(["a", "b"], ["a"])).toEqual({ missing: ["b"], unknown: [] });
  });

  it("reports unknown when the DB has migrations the repo no longer ships", () => {
    expect(diffMigrations(["a"], ["x", "a"])).toEqual({ missing: [], unknown: ["x"] });
  });
});

describe("describeMigrationDrift", () => {
  const base = {
    label: "Test DB",
    catchUpHint: "pnpm db:migrate && pnpm db:apply-functions",
    resetHint: "pnpm db:reset",
  };

  it("returns null with no expected migrations", () => {
    expect(describeMigrationDrift({ ...base, expected: [], applied: null })).toBeNull();
  });

  it("returns null when in sync", () => {
    expect(describeMigrationDrift({ ...base, expected: ["a"], applied: ["a"] })).toBeNull();
  });

  it("flags an unmigrated database with the non-destructive catch-up command", () => {
    const message = describeMigrationDrift({ ...base, expected: ["a"], applied: null });
    expect(message).toContain("no applied migrations");
    expect(message).toContain("pnpm db:migrate && pnpm db:apply-functions");
  });

  it("flags a diverged/stale baseline (unknown applied hashes) with reset", () => {
    const message = describeMigrationDrift({ ...base, expected: ["a"], applied: ["x"] });
    expect(message).toContain("diverged");
    expect(message).toContain("unknown applied");
    expect(message).toContain("pnpm db:reset");
    expect(message).not.toContain("pnpm db:migrate && pnpm db:apply-functions");
  });

  it("flags a database that is only behind with the non-destructive catch-up command", () => {
    const message = describeMigrationDrift({ ...base, expected: ["a", "b"], applied: ["a"] });
    expect(message).toContain("behind");
    expect(message).toContain("no unknown applied hashes");
    expect(message).toContain("pnpm db:migrate && pnpm db:apply-functions");
    expect(message).not.toContain("pnpm db:reset");
  });
});

describe("readExpectedMigrationHashes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "migration-state-"));
    mkdirSync(path.join(dir, "meta"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] when no journal exists", () => {
    expect(readExpectedMigrationHashes(dir)).toEqual([]);
  });

  it("hashes migration files in journal order matching drizzle's sha256(bytes)", () => {
    writeFileSync(path.join(dir, "0000_first.sql"), "CREATE TABLE a();");
    writeFileSync(path.join(dir, "0001_second.sql"), "CREATE TABLE b();");
    writeFileSync(
      path.join(dir, "meta", "_journal.json"),
      JSON.stringify({
        entries: [
          { idx: 1, tag: "0001_second" },
          { idx: 0, tag: "0000_first" },
        ],
      }),
    );

    expect(readExpectedMigrationHashes(dir)).toEqual([
      sha256("CREATE TABLE a();"),
      sha256("CREATE TABLE b();"),
    ]);
  });
});
