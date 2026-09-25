/** Verifies release migration and function SQL share one database transaction. */
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    it("rolls the migration batch back when a function fails", { timeout: 120_000 }, async () => {
      const databaseName = `meridian_release_${process.pid}_${Date.now()}`;
      const baseUrl = new URL(databaseUrl);
      const adminUrl = new URL(baseUrl);
      adminUrl.pathname = "/postgres";
      const targetUrl = new URL(baseUrl);
      targetUrl.pathname = `/${databaseName}`;
      const admin = postgres(adminUrl.toString(), { max: 1 });
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      const functionsDir = await mkdtemp(join(tmpdir(), "meridian-release-functions-"));
      const sourceFunctions = fileURLToPath(new URL("./functions/", import.meta.url));
      const migrationsDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
      try {
        await cp(sourceFunctions, functionsDir, { recursive: true });
        await writeFile(
          join(functionsDir, "consume_credit_lots_fifo.sql"),
          "CREATE FUNCTION broken (",
        );
        await expect(
          runRelease({
            databaseUrl: targetUrl.toString(),
            migrationsDirectory,
            functionsDirectory: functionsDir,
          }),
        ).rejects.toThrow();
        const target = postgres(targetUrl.toString(), { max: 1 });
        try {
          const [tables] = await target<Array<{ count: string }>>`
            SELECT count(*)::text AS count FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'users'
          `;
          const [migrations] = await target<Array<{ count: string }>>`
            SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
          `;
          expect(tables.count).toBe("0");
          expect(migrations.count).toBe("0");
        } finally {
          await target.end();
        }
      } finally {
        await rm(functionsDir, { recursive: true, force: true });
        await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        await admin.end();
      }
    });
  });
}
