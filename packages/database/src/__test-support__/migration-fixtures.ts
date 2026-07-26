/** Disposable PostgreSQL harness for seeding rows between committed migrations. */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

type MigrationFixtureSql = ReturnType<typeof postgres>;

interface MigrationJournal {
  entries: Array<{ tag: string }>;
}

export async function withPopulatedMigrationDatabase(input: {
  databaseUrl: string;
  seedBefore: string;
  seed: (sql: MigrationFixtureSql) => Promise<void>;
  verify: (sql: MigrationFixtureSql) => Promise<void>;
}): Promise<void> {
  const sourceUrl = new URL(input.databaseUrl);
  const databaseName = `meridian_migrations_${process.pid}_${Date.now()}`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;

  const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(
    await readFile(join(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
  const seedIndex = journal.entries.findIndex((entry) => entry.tag === input.seedBefore);
  if (seedIndex < 1) {
    throw new Error(`Cannot seed before unknown or initial migration: ${input.seedBefore}`);
  }

  const prefixDirectory = await mkdtemp(join(tmpdir(), "meridian-migrations-"));
  try {
    await mkdir(join(prefixDirectory, "meta"));
    await writeFile(
      join(prefixDirectory, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, seedIndex) }, null, 2),
    );
    for (const entry of journal.entries.slice(0, seedIndex)) {
      await copyFile(
        join(migrationsDirectory, `${entry.tag}.sql`),
        join(prefixDirectory, `${entry.tag}.sql`),
      );
    }

    const admin = postgres(adminUrl.toString(), { max: 1 });
    let databaseCreated = false;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      const target = postgres(targetUrl.toString(), { max: 1 });
      try {
        const db = drizzle(target);
        await migrate(db, { migrationsFolder: prefixDirectory });
        await input.seed(target);
        await migrate(db, { migrationsFolder: migrationsDirectory });
        await input.verify(target);
      } finally {
        await target.end();
      }
    } finally {
      try {
        if (databaseCreated) {
          await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        }
      } finally {
        await admin.end();
      }
    }
  } finally {
    await rm(prefixDirectory, { recursive: true, force: true });
  }
}
