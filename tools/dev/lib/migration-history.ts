/** Dev/CI-specific migration-history comparison and operator guidance. */
import {
  type DatabaseHistoryIssue,
  formatDatabaseHistoryIssue,
  type MigrationHistory,
} from "@meridian/database/release";

export {
  type AppliedMigration,
  buildMigrationHistory,
  type DatabaseHistoryIssue,
  type DatabaseMigrationPlan,
  type MigrationHistory,
  planDatabaseMigrations,
  readAppliedMigrations,
  readMigrationHistory,
} from "@meridian/database/release";

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
