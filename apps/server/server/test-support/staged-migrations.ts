/**
 * Populated-upgrade harness for migration tests: stage the repository's migrations up to a
 * journal entry in a schema moved aside from the worker's database, so rows can be seeded
 * in that shape before the rest run, as a deploy at that point would.
 */
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";

export const MIGRATIONS = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/src/migrations",
);

export type MigrationJournal = { entries: { tag: string; when: number }[] };

export async function readJournal(): Promise<MigrationJournal> {
  return JSON.parse(await readFile(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
}

/** The journal index of `tag`; throws when the repository has no such migration. */
export function journalIndex(journal: MigrationJournal, tag: string): number {
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`Migration ${tag} is not in the journal`);
  return index;
}

/** Stages the first `n` journal entries of `migrations` in `directory`. */
export async function stageThrough(
  migrations: string,
  directory: string,
  journal: MigrationJournal,
  n: number,
) {
  await cp(migrations, directory, { recursive: true });
  for (const entry of journal.entries.slice(n)) await rm(path.join(directory, `${entry.tag}.sql`));
  await writeFile(
    path.join(directory, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, n) }),
  );
}

/** Moves the database's schemas aside, so the upgrade runs in an empty one. */
export async function isolateSchemas(target: postgres.Sql) {
  await target.begin(async (tx) => {
    await tx`ALTER SCHEMA public RENAME TO staged_upgrade_saved_public`;
    await tx`ALTER SCHEMA drizzle RENAME TO staged_upgrade_saved_drizzle`;
    await tx`CREATE SCHEMA public`;
    await tx`ALTER EXTENSION pg_trgm SET SCHEMA public`;
  });
}

export async function restoreSchemas(target: postgres.Sql) {
  await target.begin(async (tx) => {
    await tx`ALTER EXTENSION pg_trgm SET SCHEMA staged_upgrade_saved_public`;
    await tx`DROP SCHEMA IF EXISTS public CASCADE`;
    await tx`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await tx`ALTER SCHEMA staged_upgrade_saved_public RENAME TO public`;
    await tx`ALTER SCHEMA staged_upgrade_saved_drizzle RENAME TO drizzle`;
  });
}
