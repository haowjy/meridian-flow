/** Executable migration-chain proof against a newly created PostgreSQL database. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!enabled || !databaseUrl) {
  describe.skip("fresh database migrations (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("fresh database migrations (postgres)", () => {
    it("applies the complete migration chain to an empty database", async () => {
      const source = new URL(databaseUrl);
      const databaseName = `meridian_migrations_${process.pid}_${Date.now()}`;
      const adminUrl = new URL(source);
      adminUrl.pathname = "/postgres";
      const targetUrl = new URL(source);
      targetUrl.pathname = `/${databaseName}`;
      const admin = postgres(adminUrl.toString(), { max: 1 });
      try {
        await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
        await run("pnpm", ["db:migrate"], {
          cwd: new URL("..", import.meta.url),
          env: { ...process.env, DATABASE_URL: targetUrl.toString() },
        });
        const target = postgres(targetUrl.toString(), { max: 1 });
        try {
          const rows = await target<{ table_name: string }[]>`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('turn_trail_work', 'change_trail_document_occurrences', 'branch_write_journal')
          `;
          expect(rows.map((row) => row.table_name).sort()).toEqual([
            "branch_write_journal",
            "change_trail_document_occurrences",
            "turn_trail_work",
          ]);
        } finally {
          await target.end();
        }
      } finally {
        await admin.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}'`,
        );
        await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await admin.end();
      }
    }, 120_000);
  });
}
