/**
 * Populated-upgrade harness for migration tests: stage the repository's migrations up to a
 * journal entry in an isolated scratch database, so rows can be seeded in that shape before
 * the rest run, as a deploy at that point would, without mutating the worker's database.
 */
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

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

export interface ScratchDatabase {
  readonly url: string;
  readonly sql: postgres.Sql;
  close(): Promise<void>;
}

/** Creates an empty scratch database with `pg_trgm` installed, never touching the worker DB. */
export async function createScratchDatabase(
  baseUrl: string,
  prefix: string,
): Promise<ScratchDatabase> {
  const scratchName = `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const scratch = new URL(baseUrl);
  scratch.pathname = `/${scratchName}`;
  const scratchUrl = scratch.toString();
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${scratchName}"`);
  const sql = postgres(scratchUrl, { max: 1, onnotice: () => {} });
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`;
  return {
    url: scratchUrl,
    sql,
    async close() {
      try {
        await sql.end();
        await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
