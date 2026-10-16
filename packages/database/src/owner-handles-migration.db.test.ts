/** 0062 gives every existing Work the handle its creation order earns and carries the counters over. */
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!enabled || !databaseUrl) {
  describe.skip("owner handles migration (postgres)", () => {});
} else {
  describe("owner handles migration (postgres)", () => {
    it("numbers Works per project by creation order, counts deleted ones, and keeps the thread counter", async () => {
      const migration = await readFile(
        new URL("./migrations/0062_owner_handles.sql", import.meta.url),
        "utf8",
      );
      const target = postgres(databaseUrl, { max: 1 });
      try {
        await target.begin(async (tx) => {
          // A scratch schema holds the pre-0062 tables, so the real ones are never touched.
          await tx.unsafe(`
            CREATE SCHEMA owner_handles_test;
            SET LOCAL search_path = owner_handles_test;
            CREATE TABLE projects (id uuid PRIMARY KEY);
            CREATE TABLE project_thread_counters (project_id uuid PRIMARY KEY, n integer NOT NULL);
            CREATE TABLE works (
              id uuid PRIMARY KEY,
              project_id uuid NOT NULL,
              name text NOT NULL,
              slug text,
              is_no_work boolean DEFAULT false NOT NULL,
              created_at timestamptz NOT NULL,
              deleted_at timestamptz,
              CONSTRAINT works_no_work_slug CHECK (true),
              CONSTRAINT works_slug_valid CHECK (true)
            );
          `);
          const [one, two, three] = [
            "10000000-0000-4000-8000-000000000001",
            "10000000-0000-4000-8000-000000000002",
            "10000000-0000-4000-8000-000000000003",
          ];
          await tx.unsafe(`
            INSERT INTO projects (id) VALUES ('${one}'), ('${two}'), ('${three}');
            INSERT INTO project_thread_counters (project_id, n) VALUES ('${one}', 14), ('${two}', 2);
            INSERT INTO works (id, project_id, name, slug, is_no_work, created_at, deleted_at) VALUES
              ('20000000-0000-4000-8000-000000000001', '${one}', 'No Work', NULL, true, '2026-01-01', NULL),
              ('20000000-0000-4000-8000-000000000002', '${one}', 'Second', 'second', false, '2026-01-03', NULL),
              ('20000000-0000-4000-8000-000000000003', '${one}', 'First', 'first', false, '2026-01-02', '2026-02-01'),
              ('20000000-0000-4000-8000-000000000004', '${two}', 'Only', 'only', false, '2026-01-01', NULL);
          `);

          for (const statement of migration.split("--> statement-breakpoint")) {
            // The foreign key points at the real public.projects, which the scratch schema lacks.
            if (statement.trim() && !statement.includes('"public"."projects"'))
              await tx.unsafe(statement);
          }

          expect(await tx`SELECT name, handle FROM works ORDER BY project_id, created_at`).toEqual([
            { name: "No Work", handle: null },
            { name: "First", handle: "w1" },
            { name: "Second", handle: "w2" },
            { name: "Only", handle: "w1" },
          ]);
          expect(
            await tx`SELECT project_id, kind, n FROM project_handle_counters ORDER BY project_id, kind`,
          ).toEqual([
            { project_id: one, kind: "thread", n: 14 },
            { project_id: one, kind: "work", n: 2 },
            { project_id: two, kind: "thread", n: 2 },
            { project_id: two, kind: "work", n: 1 },
          ]);
          await tx.unsafe("DROP SCHEMA owner_handles_test CASCADE");
        });
      } finally {
        await target.end();
      }
    });
  });
}
