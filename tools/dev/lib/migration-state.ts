/**
 * Compare the migrations a checkout expects against the migrations a live dev
 * database has actually applied. A per-worktree dev DB can silently fall behind
 * (or diverge from) the repo's migration baseline — e.g. a squashed baseline
 * leaves an older DB stamped with migration hashes the repo no longer ships.
 * The server then boots fine (connections are lazy) and only fails much later,
 * deep in feature code, on the first schema mismatch. Surfacing the drift at
 * `pnpm dev` startup turns that into a clear, actionable up-front error.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

interface JournalEntry {
  idx: number;
  tag: string;
}

interface MigrationJournal {
  entries: JournalEntry[];
}

/**
 * Expected migration hashes in journal order. drizzle records `sha256` of each
 * migration file's bytes in `drizzle.__drizzle_migrations.hash`; we recompute
 * the same value so a hash set can be compared without a DB round-trip.
 */
export function readExpectedMigrationHashes(migrationsDir: string): string[] {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  if (!existsSync(journalPath)) return [];
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as MigrationJournal;
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) =>
      createHash("sha256")
        .update(readFileSync(path.join(migrationsDir, `${entry.tag}.sql`)))
        .digest("hex"),
    );
}

export interface MigrationDiff {
  /** Repo migrations not yet applied to the DB (DB is behind). */
  missing: string[];
  /** Applied migrations the repo no longer ships (DB diverged from baseline). */
  unknown: string[];
}

export function diffMigrations(expected: string[], applied: string[]): MigrationDiff {
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((hash) => !appliedSet.has(hash)),
    unknown: applied.filter((hash) => !expectedSet.has(hash)),
  };
}

/**
 * Human-readable drift verdict, or `null` when the DB matches the repo. `applied`
 * is `null` when the migrations table is absent (DB was never migrated).
 */
export function describeMigrationDrift(input: {
  label: string;
  expected: string[];
  applied: string[] | null;
  catchUpHint: string;
  resetHint: string;
}): string | null {
  const { label, expected, applied, catchUpHint, resetHint } = input;
  if (expected.length === 0) return null;

  // Command hints are backticked and never followed by punctuation — a bare
  // trailing period reads as part of the command when copy-pasted.
  const runHint = (command: string) => `run \`${command}\``;

  if (applied === null || applied.length === 0) {
    return `${label}: database has no applied migrations — ${runHint(catchUpHint)}`;
  }

  const { missing, unknown } = diffMigrations(expected, applied);
  if (unknown.length > 0) {
    return (
      `${label}: live database diverged from repo migrations ` +
      `(${unknown.length} unknown applied migration hash(es); repo no longer ships them, likely a stale baseline) — ${runHint(resetHint)}`
    );
  }
  if (missing.length > 0) {
    return (
      `${label}: live database is behind repo migrations ` +
      `(${missing.length} pending migration(s); no unknown applied hashes) — ${runHint(catchUpHint)}`
    );
  }
  return null;
}
