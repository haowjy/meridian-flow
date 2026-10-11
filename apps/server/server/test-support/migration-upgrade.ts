/**
 * Populated-upgrade fixture support: run a prefix of the committed migration journal in an empty
 * schema, seed rows in that era's shape, then run the rest. The database's own schemas are moved
 * aside for the duration and put back afterwards.
 */
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";

export type MigrationJournal = { entries: { tag: string }[] };

export const MIGRATIONS = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/src/migrations",
);

export async function readMigrationJournal(): Promise<MigrationJournal> {
  return JSON.parse(await readFile(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
}

/** The journal index of `tag`; throws when it is absent. */
export function journalIndex(journal: MigrationJournal, tag: string): number {
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`Migration ${tag} is not in the journal`);
  return index;
}

/** Stages the first `n` journal entries in `directory`, as a deploy at that point would. */
export async function stageThrough(directory: string, journal: MigrationJournal, n: number) {
  await cp(MIGRATIONS, directory, { recursive: true });
  for (const entry of journal.entries.slice(n)) await rm(path.join(directory, `${entry.tag}.sql`));
  await writeFile(
    path.join(directory, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, n) }),
  );
}

/** Moves the database's schemas aside under `prefix`, so the upgrade runs in an empty one. */
export async function isolateSchemas(target: postgres.Sql, prefix: string) {
  await target.begin(async (tx) => {
    await tx.unsafe(`ALTER SCHEMA public RENAME TO ${prefix}_saved_public`);
    await tx.unsafe(`ALTER SCHEMA drizzle RENAME TO ${prefix}_saved_drizzle`);
    await tx`CREATE SCHEMA public`;
    await tx`ALTER EXTENSION pg_trgm SET SCHEMA public`;
  });
}

export async function restoreSchemas(target: postgres.Sql, prefix: string) {
  await target.begin(async (tx) => {
    await tx.unsafe(`ALTER EXTENSION pg_trgm SET SCHEMA ${prefix}_saved_public`);
    await tx`DROP SCHEMA IF EXISTS public CASCADE`;
    await tx`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await tx.unsafe(`ALTER SCHEMA ${prefix}_saved_public RENAME TO public`);
    await tx.unsafe(`ALTER SCHEMA ${prefix}_saved_drizzle RENAME TO drizzle`);
  });
}
