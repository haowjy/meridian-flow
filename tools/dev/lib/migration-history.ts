/** Migration identity, repository-history validation, and database migration planning. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";

export interface MigrationJournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
}

export interface MigrationIdentity extends MigrationJournalEntry {
  hash: string;
  sql: Buffer;
}

export interface MigrationHistory {
  entries: MigrationIdentity[];
  sqlFiles: ReadonlyMap<string, Buffer>;
  issues: string[];
}

export interface AppliedMigration {
  hash: string;
  createdAt: number | null;
}

export type DatabaseHistoryIssue =
  | { kind: "edited"; entry: MigrationIdentity; applied: AppliedMigration }
  | { kind: "retimestamped"; entry: MigrationIdentity; applied: AppliedMigration }
  | { kind: "missing-timestamp"; entry?: MigrationIdentity; applied: AppliedMigration }
  | { kind: "unknown"; applied: AppliedMigration }
  | { kind: "out-of-order"; entry: MigrationIdentity; newestAppliedAt: number };

export interface DatabaseMigrationPlan {
  pending: MigrationIdentity[];
  issues: DatabaseHistoryIssue[];
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildMigrationHistory(input: {
  journalText: string;
  sqlFiles: ReadonlyMap<string, Buffer>;
}): MigrationHistory {
  const journal = JSON.parse(input.journalText) as MigrationJournal;
  const issues: string[] = [];
  const journalFiles = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
  const seenTags = new Set<string>();
  const seenWhens = new Set<number>();

  for (const [position, entry] of journal.entries.entries()) {
    if (entry.idx !== position) {
      issues.push(`journal entry ${entry.tag} has idx ${entry.idx}; expected ${position}`);
    }
    const previous = journal.entries[position - 1];
    if (previous && entry.when <= previous.when) {
      issues.push(
        `journal entry ${entry.tag} has when ${entry.when}; it must be newer than ${previous.when}`,
      );
    }
    if (seenTags.has(entry.tag)) issues.push(`journal tag ${entry.tag} is duplicated`);
    if (seenWhens.has(entry.when)) issues.push(`journal when ${entry.when} is duplicated`);
    seenTags.add(entry.tag);
    seenWhens.add(entry.when);
    const file = `${entry.tag}.sql`;
    if (!input.sqlFiles.has(file)) {
      issues.push(`journal entry ${entry.idx} (${entry.tag}) is missing ${file}`);
    }
  }
  for (const file of input.sqlFiles.keys()) {
    if (!journalFiles.has(file)) issues.push(`${file} is not listed in meta/_journal.json`);
  }

  const entries = journal.entries.flatMap((entry) => {
    const bytes = input.sqlFiles.get(`${entry.tag}.sql`);
    return bytes ? [{ ...entry, hash: sha256(bytes), sql: bytes }] : [];
  });
  return { entries, sqlFiles: input.sqlFiles, issues };
}

export function readMigrationHistory(migrationsDirectory: string): MigrationHistory {
  const journalPath = path.join(migrationsDirectory, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    return { entries: [], sqlFiles: new Map(), issues: [`${journalPath} does not exist`] };
  }
  const sqlFiles = new Map<string, Buffer>();
  for (const file of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql"))) {
    sqlFiles.set(file, readFileSync(path.join(migrationsDirectory, file)));
  }
  return buildMigrationHistory({ journalText: readFileSync(journalPath, "utf8"), sqlFiles });
}

export function compareRepositoryMigrationHistory(
  base: MigrationHistory,
  head: MigrationHistory,
): string[] {
  const issues = [
    ...base.issues.map((issue) => `base history is inconsistent: ${issue}`),
    ...head.issues.map((issue) => `head history is inconsistent: ${issue}`),
  ];
  for (const [index, baseEntry] of base.entries.entries()) {
    const headEntry = head.entries[index];
    if (!headEntry) {
      issues.push(`base journal entry ${baseEntry.idx} (${baseEntry.tag}) was removed`);
      continue;
    }
    const changedFields = (["tag", "idx", "when", "breakpoints"] as const).filter(
      (field) => headEntry[field] !== baseEntry[field],
    );
    if (changedFields.length > 0) {
      issues.push(
        `base journal entry ${baseEntry.idx} (${baseEntry.tag}) changed ${changedFields.join(", ")}`,
      );
    }
    if (headEntry.hash !== baseEntry.hash) {
      issues.push(`base migration ${baseEntry.tag}.sql was edited`);
    }
  }

  for (const file of base.sqlFiles.keys()) {
    if (!head.sqlFiles.has(file)) issues.push(`base migration file ${file} was deleted`);
  }

  return [...new Set(issues)];
}

/** Read applied identities without creating the Drizzle schema or migration table. */
export async function readAppliedMigrations(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<AppliedMigration[] | null> {
  const present = await sql<{ exists: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`;
  if (!present[0]?.exists) return null;
  const rows = await sql<Array<{ hash: string; createdAt: string | number | null }>>`
    SELECT hash, created_at AS "createdAt"
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at, id`;
  return rows.map((row) => ({
    hash: row.hash,
    createdAt: row.createdAt === null ? null : Number(row.createdAt),
  }));
}

export function planDatabaseMigrations(
  history: MigrationHistory,
  applied: readonly AppliedMigration[],
): DatabaseMigrationPlan {
  const byWhen = new Map(history.entries.map((entry) => [entry.when, entry]));
  const byHash = new Map(history.entries.map((entry) => [entry.hash, entry]));
  const exactApplied = new Set<string>();
  const issues: DatabaseHistoryIssue[] = [];

  for (const row of applied) {
    if (row.createdAt === null) {
      issues.push({ kind: "missing-timestamp", entry: byHash.get(row.hash), applied: row });
      continue;
    }
    const atWhen = byWhen.get(row.createdAt);
    const withHash = byHash.get(row.hash);
    if (atWhen?.hash === row.hash) {
      exactApplied.add(`${row.hash}:${row.createdAt}`);
    } else if (withHash) {
      issues.push({ kind: "retimestamped", entry: withHash, applied: row });
    } else if (atWhen) {
      issues.push({ kind: "edited", entry: atWhen, applied: row });
    } else {
      issues.push({ kind: "unknown", applied: row });
    }
  }

  const pending = history.entries.filter(
    (entry) => !exactApplied.has(`${entry.hash}:${entry.when}`),
  );
  const newestAppliedAt = applied.reduce<number | undefined>(
    (latest, row) =>
      row.createdAt !== null && (latest === undefined || row.createdAt > latest)
        ? row.createdAt
        : latest,
    undefined,
  );
  if (newestAppliedAt !== undefined) {
    for (const entry of pending) {
      if (entry.when <= newestAppliedAt) {
        issues.push({ kind: "out-of-order", entry, newestAppliedAt });
      }
    }
  }
  return { pending, issues };
}

export function formatDatabaseHistoryIssue(issue: DatabaseHistoryIssue): string {
  switch (issue.kind) {
    case "edited":
      return `migration ${issue.entry.tag} was edited after this database applied it`;
    case "retimestamped":
      return (
        `this database applied ${issue.entry.tag} under a different number or timestamp ` +
        `(database created_at ${issue.applied.createdAt}, checkout when ${issue.entry.when}; a branch renumbered it)`
      );
    case "missing-timestamp":
      return issue.entry
        ? `this database recorded ${issue.entry.tag} without a created_at timestamp; its migration identity cannot be verified`
        : `this database recorded a migration without a created_at timestamp (hash ${issue.applied.hash.slice(0, 12)}); its identity cannot be verified`;
    case "unknown":
      return (
        `this database applied a migration this checkout doesn't have ` +
        `(hash ${issue.applied.hash.slice(0, 12)} at created_at ${issue.applied.createdAt}; another branch's history)`
      );
    case "out-of-order":
      return (
        `pending migration ${issue.entry.tag} (when ${issue.entry.when}) is not newer than ` +
        `the newest applied migration (created_at ${issue.newestAppliedAt}); applying it would be out of order`
      );
  }
}

export function formatDatabaseHistoryRefusal(input: {
  databaseName: string;
  issues: readonly DatabaseHistoryIssue[];
  prefix?: string;
  localDevDatabase: boolean;
  resetCommand?: string;
}): string {
  const details = input.issues
    .map((issue) => `  - ${formatDatabaseHistoryIssue(issue)}`)
    .join("\n");
  const fix = input.localDevDatabase
    ? `Fix: Run \`${input.resetCommand ?? "pnpm db:reset"}\` from the checkout that owns this dev database.`
    : "Fix: This is a shared or deployed database and requires human repair. Do not reset it.";
  return `${input.prefix ?? "db:migrate"}: refused migration history for database "${input.databaseName}"\n${details}\n${fix}`;
}
