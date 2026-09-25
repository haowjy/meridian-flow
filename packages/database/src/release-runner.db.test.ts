/** Verifies release migration and function SQL share one database transaction. */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getSchemaStatus, runRelease } from "./release-runner";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!enabled || !databaseUrl) {
  describe.skip("atomic release database tests", () => {});
} else {
  describe("atomic release database tests", () => {
    const sourceMigrations = fileURLToPath(new URL("../src/migrations/", import.meta.url));
    const sourceFunctions = fileURLToPath(new URL("./functions/", import.meta.url));

    async function prefixBundle(changedSql = false) {
      const fixtureDirectory = await mkdtemp(join(tmpdir(), "meridian-release-prefix-"));
      const migrationsDirectory = join(fixtureDirectory, "migrations");
      const journal = JSON.parse(
        await readFile(join(sourceMigrations, "meta/_journal.json"), "utf8"),
      ) as { entries: Array<{ tag: string; when: number; [key: string]: unknown }> };
      const first = journal.entries[0];
      let sql = await readFile(join(sourceMigrations, `${first.tag}.sql`), "utf8");
      if (changedSql) sql += "\n-- deliberately divergent migration history\n";
      await mkdir(join(migrationsDirectory, "meta"), { recursive: true });
      await writeFile(
        join(migrationsDirectory, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: [first] }),
      );
      await writeFile(join(migrationsDirectory, `${first.tag}.sql`), sql);
      return { fixtureDirectory, migrationsDirectory };
    }

    it("rolls the migration batch back when a function fails", async () => {
      const fixtureDirectory = await mkdtemp(join(tmpdir(), "meridian-release-fixture-"));
      const functionsDir = join(fixtureDirectory, "functions");
      const migrationsDirectory = join(fixtureDirectory, "migrations");
      const tableName = `release_atomicity_probe_${process.pid}_${Date.now()}`;
      const target = postgres(databaseUrl, { max: 1, onnotice: () => {} });
      try {
        await target.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
        await target.unsafe(`
          CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
          )
        `);
        await cp(sourceMigrations, migrationsDirectory, { recursive: true });
        const journalPath = join(migrationsDirectory, "meta/_journal.json");
        const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
          entries: Array<{
            idx: number;
            version: string;
            when: number;
            tag: string;
            breakpoints: boolean;
          }>;
        };
        const lastWhen = journal.entries.at(-1)?.when ?? 0;
        const when = Math.max(Date.now(), lastWhen + 1);
        journal.entries.push({
          idx: journal.entries.length,
          version: "7",
          when,
          tag: "9999_release_probe",
          breakpoints: true,
        });
        await writeFile(journalPath, JSON.stringify(journal));
        await writeFile(
          join(migrationsDirectory, "9999_release_probe.sql"),
          `CREATE TABLE ${tableName} (id integer PRIMARY KEY);`,
        );
        await cp(sourceFunctions, functionsDir, { recursive: true });
        await writeFile(
          join(functionsDir, "consume_credit_lots_fifo.sql"),
          "CREATE FUNCTION broken (",
        );
        const [before] = await target<Array<{ count: string }>>`
          SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
        `;
        await expect(
          runRelease({
            databaseUrl,
            migrationsDirectory,
            functionsDirectory: functionsDir,
          }),
        ).rejects.toThrow(/syntax error/i);
        const [tables] = await target<Array<{ count: string }>>`
          SELECT count(*)::text AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ${tableName}
        `;
        const [after] = await target<Array<{ count: string }>>`
          SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
        `;
        expect(tables.count).toBe("0");
        expect(after.count).toBe(before.count);
      } finally {
        await target.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
        await target.end();
        await rm(fixtureDirectory, { recursive: true, force: true });
      }
    });

    it("treats a matching journal prefix as zero pending when the database is ahead", async () => {
      const { fixtureDirectory, migrationsDirectory } = await prefixBundle();
      try {
        const result = await runRelease({
          databaseUrl,
          migrationsDirectory,
          functionsDirectory: sourceFunctions,
        });
        expect(result.appliedMigrations).toBe(0);
      } finally {
        await rm(fixtureDirectory, { recursive: true, force: true });
      }
    });

    it("skips the rollback bundle's function SQL when database history is ahead", async () => {
      const { fixtureDirectory, migrationsDirectory } = await prefixBundle();
      const functionsDirectory = join(fixtureDirectory, "functions");
      try {
        await cp(sourceFunctions, functionsDirectory, { recursive: true });
        await writeFile(
          join(functionsDirectory, "consume_credit_lots_fifo.sql"),
          "CREATE FUNCTION broken (",
        );
        expect(await getSchemaStatus({ databaseUrl, migrationsDirectory })).toBe("ahead");
        const result = await runRelease({ databaseUrl, migrationsDirectory, functionsDirectory });
        expect(result).toEqual({ appliedMigrations: 0, skippedFunctions: true });
      } finally {
        await rm(fixtureDirectory, { recursive: true, force: true });
      }
    });

    it("fails when the applied ledger diverges from the bundle prefix", async () => {
      const { fixtureDirectory, migrationsDirectory } = await prefixBundle(true);
      try {
        await expect(
          runRelease({ databaseUrl, migrationsDirectory, functionsDirectory: sourceFunctions }),
        ).rejects.toThrow(/Divergent migration history at ordinal 0/);
      } finally {
        await rm(fixtureDirectory, { recursive: true, force: true });
      }
    });

    it("reports behind when the bundle journal contains an unapplied migration", async () => {
      await runRelease({
        databaseUrl,
        migrationsDirectory: sourceMigrations,
        functionsDirectory: sourceFunctions,
      });
      const fixtureDirectory = await mkdtemp(join(tmpdir(), "meridian-release-behind-"));
      const migrationsDirectory = join(fixtureDirectory, "migrations");
      try {
        await cp(sourceMigrations, migrationsDirectory, { recursive: true });
        const journalPath = join(migrationsDirectory, "meta/_journal.json");
        const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
          entries: Array<Record<string, unknown>>;
        };
        journal.entries.push({
          idx: journal.entries.length,
          version: "7",
          when: Date.now() + 1,
          tag: "9999_unapplied_probe",
          breakpoints: true,
        });
        await writeFile(journalPath, JSON.stringify(journal));
        await writeFile(join(migrationsDirectory, "9999_unapplied_probe.sql"), "SELECT 1;");
        expect(await getSchemaStatus({ databaseUrl, migrationsDirectory })).toBe("behind");
      } finally {
        await rm(fixtureDirectory, { recursive: true, force: true });
      }
    });
  });
}
