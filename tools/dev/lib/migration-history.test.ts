/** Behavioral tests for repository and database migration-history guards. */
import { describe, expect, it } from "vitest";
import {
  type AppliedMigration,
  buildMigrationHistory,
  compareRepositoryMigrationHistory,
  formatDatabaseHistoryRefusal,
  type MigrationHistory,
  planDatabaseMigrations,
} from "./migration-history";

interface EntryInput {
  idx: number;
  tag: string;
  when: number;
  breakpoints?: boolean;
  sql?: string;
}

function history(entries: EntryInput[], extraFiles: Record<string, string> = {}): MigrationHistory {
  const sqlFiles = new Map<string, Buffer>(
    entries
      .filter((entry) => entry.sql !== undefined)
      .map((entry) => [`${entry.tag}.sql`, Buffer.from(entry.sql ?? "")]),
  );
  for (const [name, body] of Object.entries(extraFiles)) sqlFiles.set(name, Buffer.from(body));
  return buildMigrationHistory({
    journalText: JSON.stringify({
      entries: entries.map(({ idx, tag, when, breakpoints = true }) => ({
        idx,
        tag,
        when,
        breakpoints,
      })),
    }),
    sqlFiles,
  });
}

function applied(
  entry: MigrationHistory["entries"][number],
  createdAt: number | null = entry.when,
): AppliedMigration {
  return { hash: entry.hash, createdAt };
}

describe("compareRepositoryMigrationHistory", () => {
  const baseEntries: EntryInput[] = [
    { idx: 0, tag: "0000_first", when: 100, sql: "SELECT 1;" },
    { idx: 1, tag: "0001_second", when: 200, sql: "SELECT 2;" },
  ];

  it("accepts unchanged and append-only histories", () => {
    const base = history(baseEntries);
    expect(compareRepositoryMigrationHistory(base, history(baseEntries))).toEqual([]);
    expect(
      compareRepositoryMigrationHistory(
        base,
        history([...baseEntries, { idx: 2, tag: "0002_third", when: 300, sql: "SELECT 3;" }]),
      ),
    ).toEqual([]);
  });

  it("rejects an edited base SQL file", () => {
    const issues = compareRepositoryMigrationHistory(
      history(baseEntries),
      history([{ ...baseEntries[0], sql: "SELECT 99;" }, baseEntries[1]]),
    );
    expect(
      issues.some((issue) => issue.includes("0000_first.sql") && issue.includes("edited")),
    ).toBe(true);
  });

  it("rejects a removed base entry and file", () => {
    const issues = compareRepositoryMigrationHistory(
      history(baseEntries),
      history([baseEntries[0]]),
    );
    expect(issues).toContain("base journal entry 1 (0001_second) was removed");
    expect(issues).toContain("base migration file 0001_second.sql was deleted");
  });

  it.each([
    ["idx", { idx: 7 }],
    ["when", { when: 250 }],
  ])("rejects a base entry changed in %s", (field, change) => {
    const issues = compareRepositoryMigrationHistory(
      history(baseEntries),
      history([baseEntries[0], { ...baseEntries[1], ...change }]),
    );
    expect(issues.some((issue) => issue.includes(`changed ${field}`))).toBe(true);
  });

  it("rejects new migrations older than the base tip and gaps in idx", () => {
    const issues = compareRepositoryMigrationHistory(
      history(baseEntries),
      history([...baseEntries, { idx: 4, tag: "0004_old", when: 150, sql: "SELECT 4;" }]),
    );
    expect(issues.some((issue) => issue.includes("0004_old") && issue.includes("expected 2"))).toBe(
      true,
    );
    expect(
      issues.some((issue) => issue.includes("0004_old") && issue.includes("newer than 200")),
    ).toBe(true);
  });

  it("rejects reordered entries", () => {
    const issues = compareRepositoryMigrationHistory(
      history(baseEntries),
      history([baseEntries[1], baseEntries[0]]),
    );
    expect(issues.some((issue) => issue.includes("head history is inconsistent"))).toBe(true);
    expect(issues.some((issue) => issue.includes("changed tag"))).toBe(true);
  });

  it("rejects duplicate timestamps and tags", () => {
    const duplicateWhen = history([
      baseEntries[0],
      { ...baseEntries[1], when: baseEntries[0].when },
    ]);
    expect(duplicateWhen.issues.some((issue) => issue.includes("when 100 is duplicated"))).toBe(
      true,
    );

    const duplicateTag = history([baseEntries[0], { ...baseEntries[1], tag: baseEntries[0].tag }]);
    expect(
      duplicateTag.issues.some((issue) => issue.includes("tag 0000_first is duplicated")),
    ).toBe(true);
  });

  it("rejects stray and missing SQL files", () => {
    const base = history(baseEntries);
    const stray = history(baseEntries, { "0099_stray.sql": "SELECT 99;" });
    expect(compareRepositoryMigrationHistory(base, stray)).toContain(
      "head history is inconsistent: 0099_stray.sql is not listed in meta/_journal.json",
    );

    const missing = history([{ ...baseEntries[0], sql: undefined }, baseEntries[1]]);
    expect(compareRepositoryMigrationHistory(base, missing)).toContain(
      "head history is inconsistent: journal entry 0 (0000_first) is missing 0000_first.sql",
    );
  });
});

describe("planDatabaseMigrations", () => {
  const expected = history([
    { idx: 0, tag: "0000_first", when: 100, sql: "SELECT 1;" },
    { idx: 1, tag: "0001_second", when: 200, sql: "SELECT 2;" },
    { idx: 2, tag: "0002_third", when: 300, sql: "SELECT 3;" },
  ]);
  const [first, second, third] = expected.entries;

  it("plans fresh, behind, and current databases", () => {
    expect(planDatabaseMigrations(expected, [])).toEqual({
      pending: [first, second, third],
      issues: [],
    });
    expect(planDatabaseMigrations(expected, [applied(first)])).toEqual({
      pending: [second, third],
      issues: [],
    });
    expect(
      planDatabaseMigrations(expected, [applied(first), applied(second), applied(third)]),
    ).toEqual({
      pending: [],
      issues: [],
    });
  });

  it("classifies unknown applied migrations", () => {
    const plan = planDatabaseMigrations(expected, [{ hash: "unknown", createdAt: 50 }]);
    expect(plan.issues[0]?.kind).toBe("unknown");
  });

  it("classifies an applied migration edited at the same timestamp", () => {
    const plan = planDatabaseMigrations(expected, [{ hash: "old-hash", createdAt: first.when }]);
    expect(plan.issues.some((issue) => issue.kind === "edited" && issue.entry === first)).toBe(
      true,
    );
  });

  it("classifies a known hash moved onto another entry's timestamp as retimestamped", () => {
    const plan = planDatabaseMigrations(expected, [applied(first, second.when)]);
    expect(
      plan.issues.some((issue) => issue.kind === "retimestamped" && issue.entry === first),
    ).toBe(true);
    expect(plan.issues.some((issue) => issue.kind === "edited")).toBe(false);
  });

  it("classifies a null applied timestamp separately", () => {
    const plan = planDatabaseMigrations(expected, [applied(first, null)]);
    expect(
      plan.issues.some((issue) => issue.kind === "missing-timestamp" && issue.entry === first),
    ).toBe(true);
  });

  it("classifies the M4 renumbering shape and its older pending entries", () => {
    const plan = planDatabaseMigrations(expected, [applied(first, 400), applied(second, 500)]);
    expect(plan.issues.filter((issue) => issue.kind === "retimestamped")).toHaveLength(2);
    expect(
      plan.issues.some((issue) => issue.kind === "out-of-order" && issue.entry === third),
    ).toBe(true);
  });

  it("refuses an out-of-order pending migration", () => {
    const plan = planDatabaseMigrations(expected, [applied(second)]);
    expect(
      plan.issues.some((issue) => issue.kind === "out-of-order" && issue.entry === first),
    ).toBe(true);
  });
});

describe("formatDatabaseHistoryRefusal", () => {
  const migration = history([{ idx: 0, tag: "0000_first", when: 100, sql: "SELECT 1;" }])
    .entries[0];
  const issues = [{ kind: "edited" as const, entry: migration, applied: applied(migration) }];

  it("uses the caller prefix and local reset command", () => {
    const message = formatDatabaseHistoryRefusal({
      databaseName: "local",
      issues,
      prefix: "primary database",
      localDevDatabase: true,
      resetCommand: "pnpm db:reset",
    });
    expect(message).toContain('primary database: refused migration history for database "local"');
    expect(message).toContain("Run `pnpm db:reset`");
  });

  it("never recommends reset for a shared database", () => {
    const message = formatDatabaseHistoryRefusal({
      databaseName: "shared",
      issues,
      localDevDatabase: false,
    });
    expect(message).toContain("requires human repair");
    expect(message).not.toContain("pnpm db:reset");
  });
});
