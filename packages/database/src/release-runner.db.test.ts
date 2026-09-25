/** Verifies release migration and function SQL share one database transaction. */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { runRelease } from "./release-runner";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!enabled || !databaseUrl) {
  describe.skip("atomic release database tests", () => {});
} else {
  describe("atomic release database tests", () => {
    it("rolls the migration batch back when a function fails", async () => {
      const fixtureDirectory = await mkdtemp(join(tmpdir(), "meridian-release-fixture-"));
      const functionsDir = join(fixtureDirectory, "functions");
      const migrationsDirectory = join(fixtureDirectory, "migrations");
      const sourceFunctions = fileURLToPath(new URL("./functions/", import.meta.url));
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
        await mkdir(join(migrationsDirectory, "meta"), { recursive: true });
        const when = Date.now();
        await writeFile(
          join(migrationsDirectory, "meta/_journal.json"),
          JSON.stringify({
            version: "7",
            dialect: "postgresql",
            entries: [{ idx: 0, version: "7", when, tag: "0000_release_probe", breakpoints: true }],
          }),
        );
        await writeFile(
          join(migrationsDirectory, "0000_release_probe.sql"),
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
        ).rejects.toThrow();
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
  });
}
