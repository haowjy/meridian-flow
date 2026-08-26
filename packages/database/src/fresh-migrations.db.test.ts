/** Migration-chain catalog proof against the runner-owned fresh PostgreSQL database. */
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { withPopulatedMigrationDatabase } from "./__test-support__/migration-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!enabled || !databaseUrl) {
  describe.skip("fresh database migrations (postgres)", () => {});
} else {
  describe("fresh database migrations (postgres)", () => {
    it("keeps the renumbered migration tail eligible for incremental upgrades", async () => {
      const journal = JSON.parse(
        await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
      ) as {
        entries: Array<{ tag: string; when: number }>;
      };
      const tailStart = journal.entries.findIndex(
        (entry) => entry.tag === "0060_cultured_cobalt_man",
      );
      const tail = journal.entries.slice(tailStart);

      expect(tail.map((entry) => entry.tag)).toEqual([
        "0060_cultured_cobalt_man",
        "0061_milky_hedge_knight",
        "0062_mature_prism",
        "0063_milky_celestials",
        "0064_writer_impact",
        "0065_secret_red_ghost",
        "0066_tired_proudstar",
        "0067_blue_eddie_brock",
        "0068_search_tool_rename",
        "0069_multi_work_v1",
        "0070_opposite_white_queen",
        "0071_shallow_karnak",
        "0072_aberrant_callisto",
        "0073_mean_silver_surfer",
        "0074_cute_domino",
      ]);
      for (let index = 1; index < tail.length; index += 1) {
        expect(tail[index]?.when).toBeGreaterThan(tail[index - 1]?.when ?? 0);
      }
    });

    it("exposes the expected catalog on the runner-migrated database", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      try {
        const rows = await target<{ table_name: string }[]>`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('turn_trail_work', 'change_trail_document_occurrences', 'branch_write_journal', 'work_context_delivery_obligations')
          `;
        expect(rows.map((row) => row.table_name).sort()).toEqual([
          "branch_write_journal",
          "change_trail_document_occurrences",
          "turn_trail_work",
          "work_context_delivery_obligations",
        ]);
        const triggers = await target<{ event_object_table: string; trigger_name: string }[]>`
            SELECT event_object_table, trigger_name
            FROM information_schema.triggers
            WHERE trigger_schema = 'public'
              AND trigger_name IN ('enlist_turn_trail_work', 'complete_turn_trail_work')
            ORDER BY trigger_name
          `;
        expect(triggers).toEqual([
          {
            event_object_table: "branch_write_journal",
            trigger_name: "complete_turn_trail_work",
          },
          {
            event_object_table: "branch_write_journal",
            trigger_name: "enlist_turn_trail_work",
          },
        ]);
        const indexes = await target<{ indexdef: string; indexname: string }[]>`
          SELECT indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'document_branches_active_work_draft_by_work'
        `;
        expect(indexes).toEqual([
          {
            indexname: "document_branches_active_work_draft_by_work",
            indexdef:
              "CREATE INDEX document_branches_active_work_draft_by_work ON public.document_branches USING btree (work_id, id, generation) WHERE ((kind = 'work_draft'::text) AND (status = 'active'::text))",
          },
        ]);
      } finally {
        await target.end();
      }
    });
    it("backfills active Work slugs without letting deleted Works reserve them", {
      timeout: 90_000,
    }, async () => {
      const ids = {
        user: "00000000-0000-4000-8000-000000000211",
        project: "00000000-0000-4000-8000-000000000212",
        deletedFirst: "00000000-0000-4000-8000-000000000213",
        live: "00000000-0000-4000-8000-000000000214",
        archived: "00000000-0000-4000-8000-000000000215",
        deletedLast: "00000000-0000-4000-8000-000000000216",
      };

      await withPopulatedMigrationDatabase({
        databaseUrl,
        seedBefore: "0070_opposite_white_queen",
        seed: async (target) => {
          await target.unsafe(`
            INSERT INTO users (id, external_id, email)
            VALUES ('${ids.user}', 'work-slug-fixture', 'work-slug@test.invalid');
            INSERT INTO projects (id, user_id, name, slug)
            VALUES ('${ids.project}', '${ids.user}', 'Work slug fixture', 'work-slug-fixture');
            INSERT INTO works (
              id, project_id, created_by_user_id, name, status, created_at, deleted_at
            ) VALUES
              ('${ids.deletedFirst}', '${ids.project}', '${ids.user}', 'Book 2!', 'active',
                '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
              ('${ids.live}', '${ids.project}', '${ids.user}', 'Book 2?', 'active',
                '2026-01-03T00:00:00Z', NULL),
              ('${ids.archived}', '${ids.project}', '${ids.user}', 'Book 2.', 'archived',
                '2026-01-04T00:00:00Z', NULL),
              ('${ids.deletedLast}', '${ids.project}', '${ids.user}', 'Book 2#', 'active',
                '2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z');
          `);
        },
        verify: async (target) => {
          const rows = await target<{ id: string; slug: string }[]>`
            SELECT id, slug FROM works WHERE project_id = ${ids.project}
          `;
          const slugs = new Map(rows.map((row) => [row.id, row.slug]));
          expect(slugs.get(ids.live)).toBe("book-2");
          expect(slugs.get(ids.archived)).toBe("book-2-2");
          expect(slugs.get(ids.deletedFirst)).toBe("book-2");
          expect(slugs.get(ids.deletedLast)).toBe("book-2");
        },
      });
    });
    // Replays the entire migration chain into a fresh database: 10-22s alone,
    // and past the package's 30s default when parallel checkouts share the
    // one Postgres container. The budget is the replay's, not the assertion's.
    it("renames the frozen search directive without touching prompts that only mention grep", {
      timeout: 90_000,
    }, async () => {
      const ids = {
        user: "00000000-0000-4000-8000-000000000201",
        project: "00000000-0000-4000-8000-000000000202",
        directive: "00000000-0000-4000-8000-000000000203",
        partial: "00000000-0000-4000-8000-000000000204",
        prose: "00000000-0000-4000-8000-000000000205",
        empty: "00000000-0000-4000-8000-000000000206",
      };
      const directiveBefore =
        "Use `write` with command=create/read for document content; use `ls` and `grep` for discovery.";
      const directiveAfter =
        "Use `write` with command=create/read for document content; use `ls` and `search` for discovery.";
      // Close enough to be selected by a loose predicate, never close enough to
      // be rewritten by the replacement: the row that stayed eligible forever.
      const partial = "When you need a file, call `grep` for discovery.";
      const prose = "The writer asked about grep yesterday; do not mention it.";

      await withPopulatedMigrationDatabase({
        databaseUrl,
        seedBefore: "0068_search_tool_rename",
        seed: async (target) => {
          await target.unsafe(`
            INSERT INTO users (id, external_id, email)
            VALUES ('${ids.user}', 'search-rename-fixture', 'search-rename@test.invalid');
            INSERT INTO projects (id, user_id, name, slug)
            VALUES ('${ids.project}', '${ids.user}', 'Search rename fixture', 'search-rename-fixture');
          `);
          for (const [id, prompt] of [
            [ids.directive, `'${directiveBefore}'`],
            [ids.partial, `'${partial}'`],
            [ids.prose, `'${prose}'`],
            [ids.empty, "NULL"],
          ] as const) {
            await target.unsafe(`
              INSERT INTO threads (
                id, project_id, created_by_user_id, title, kind, status, composed_system_prompt
              )
              VALUES ('${id}', '${ids.project}', '${ids.user}', 'Search rename fixture', 'primary', 'idle', ${prompt});
            `);
          }
        },
        verify: async (target) => {
          const prompts = new Map(
            (
              await target<{ id: string; composed_system_prompt: string | null }[]>`
                SELECT id, composed_system_prompt FROM threads
                WHERE project_id = ${ids.project}
              `
            ).map((row) => [row.id, row.composed_system_prompt]),
          );

          expect(prompts.get(ids.directive)).toBe(directiveAfter);
          expect(prompts.get(ids.partial)).toBe(partial);
          expect(prompts.get(ids.prose)).toBe(prose);
          expect(prompts.get(ids.empty)).toBeNull();

          // Selection-idempotent, not merely value-idempotent: re-running the
          // migration must find nothing left to do. A predicate wider than its
          // own replacement keeps re-selecting rows it can never change.
          const migration = await readFile(
            new URL("./migrations/0068_search_tool_rename.sql", import.meta.url),
            "utf8",
          );
          const replayed = await target.unsafe(
            migration.replaceAll("--> statement-breakpoint", ""),
          );
          expect(replayed.count).toBe(0);
        },
      });
    });
  });
}
