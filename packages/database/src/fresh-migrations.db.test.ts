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

      expect(tailStart).toBeGreaterThanOrEqual(0);
      for (let index = 1; index < tail.length; index += 1) {
        expect(tail[index]?.when).toBeGreaterThan(tail[index - 1]?.when ?? 0);
      }
    });
    it("moves only provisional Scratch writing into Unfiled without changing document identity", {
      timeout: 90_000,
    }, async () => {
      await withPopulatedMigrationDatabase({
        databaseUrl,
        seedBefore: "0086_unfiled_provisional_documents",
        seed: async (target) => {
          await target.unsafe(`
INSERT INTO users(id,external_id,email) VALUES ('00000000-0000-4000-8000-000000000099','unfiled-migration','unfiled-migration@test.invalid');
INSERT INTO projects(id,user_id,name,slug) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000099','Probe','probe');
INSERT INTO works(id,project_id,created_by_user_id,name,slug,status) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000099','Archived','archived','archived');
INSERT INTO context_sources(id,project_id,name,slug) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Shared','scratch'),('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','Unfiled','unfiled');
INSERT INTO context_sources(id,work_id,name,slug,scope) VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','Scratch','scratch','work');
INSERT INTO folders(id,context_source_id,name) VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000004','Nested'),('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000005','Untitled 2.md');
INSERT INTO documents(id,context_source_id,folder_id,name,provisional_name,markdown_projection) VALUES ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000003',NULL,'Untitled 1',true,'one'),('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000006','Untitled 1',true,'two'),('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000004',NULL,'Keep scratch',false,'three'),('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000005',NULL,'Untitled 1',false,'occupied');
INSERT INTO context_catalog_scope_heads(scope_key,scope) VALUES ('project:probe',jsonb_build_object('kind','project','projectId','00000000-0000-4000-8000-000000000001'));
          `);
        },
        verify: async (target) => {
          const documents = await target`
            SELECT d.id, s.slug, d.name, d.folder_id, d.markdown_projection
            FROM documents d JOIN context_sources s ON s.id = d.context_source_id
            WHERE d.kind = 'content' ORDER BY d.id`;
          expect(documents).toEqual([
            {
              id: "00000000-0000-4000-8000-000000000010",
              slug: "unfiled",
              name: "Untitled 3",
              folder_id: null,
              markdown_projection: "one",
            },
            {
              id: "00000000-0000-4000-8000-000000000011",
              slug: "unfiled",
              name: "Untitled 4",
              folder_id: null,
              markdown_projection: "two",
            },
            {
              id: "00000000-0000-4000-8000-000000000012",
              slug: "scratch",
              name: "Keep scratch",
              folder_id: null,
              markdown_projection: "three",
            },
            {
              id: "00000000-0000-4000-8000-000000000013",
              slug: "unfiled",
              name: "Untitled 1",
              folder_id: null,
              markdown_projection: "occupied",
            },
          ]);
          expect(
            await target`SELECT path, document_id FROM document_previous_locations ORDER BY document_id`,
          ).toEqual([
            { path: "Untitled 1.md", document_id: "00000000-0000-4000-8000-000000000010" },
            { path: "Nested/Untitled 1.md", document_id: "00000000-0000-4000-8000-000000000011" },
          ]);
          expect(await target`SELECT scope_key FROM context_catalog_scope_heads`).toEqual([]);
          expect(await target`SELECT authority_key FROM context_availability_heads`).toEqual([
            { authority_key: "project:00000000-0000-4000-8000-000000000001" },
          ]);
          await target.unsafe(
            await readFile(
              new URL("./migrations/0086_unfiled_provisional_documents.sql", import.meta.url),
              "utf8",
            ),
          );
          expect(
            await target`
            SELECT d.id, s.slug, d.name, d.folder_id, d.markdown_projection
            FROM documents d JOIN context_sources s ON s.id = d.context_source_id
            WHERE d.kind = 'content' ORDER BY d.id`,
          ).toEqual(documents);
        },
      });
    });

    it("backfills readable project and untitled chat handles with deleted reservations", {
      timeout: 90_000,
    }, async () => {
      await withPopulatedMigrationDatabase({
        databaseUrl,
        seedBefore: "0083_watery_wind_dancer",
        seed: async (target) => {
          await target.unsafe(`
            INSERT INTO users (id, external_id, email) VALUES ('00000000-0000-4000-8000-000000000231', 'readable-upgrade', 'readable-upgrade@test.invalid');
            INSERT INTO projects (id, user_id, name, slug, created_at, deleted_at) VALUES
              ('00000000-0000-4000-8000-000000000232', '00000000-0000-4000-8000-000000000231', 'Silver Moon', 'silver-moon-12345678', '2026-01-01', '2026-01-02'),
              ('00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000231', 'Silver Moon', 'silver-moon-87654321', '2026-01-03', NULL);
            INSERT INTO threads (id, project_id, created_by_user_id, title, slug) VALUES
              ('00000000-0000-4000-8000-000000000234', '00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000231', '', NULL),
              ('00000000-0000-4000-8000-000000000235', '00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000231', 'Chat', 'chat'),
              ('00000000-0000-4000-8000-000000000236', '00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000231', 'Fight Scene', NULL);
            INSERT INTO threads (id, project_id, created_by_user_id, title, slug, deleted_at) VALUES
              ('00000000-0000-4000-8000-000000000237', '00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000231', 'Deleted Chat', 'chat', '2026-01-01');
          `);
        },
        verify: async (target) => {
          expect(
            await target`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'threads' AND column_name = 'slug'`,
          ).toEqual([{ is_nullable: "NO" }]);
          await expect(
            target`INSERT INTO threads (id, project_id, created_by_user_id, title) VALUES ('00000000-0000-4000-8000-000000000238', '00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000231', 'Missing handle')`,
          ).rejects.toMatchObject({ code: "23502" });
          expect(
            await target`SELECT slug FROM projects WHERE user_id = '00000000-0000-4000-8000-000000000231' ORDER BY created_at`,
          ).toEqual([{ slug: "silver-moon" }, { slug: "silver-moon-2" }]);
          expect(
            await target`SELECT slug FROM threads WHERE project_id = '00000000-0000-4000-8000-000000000233' ORDER BY id`,
          ).toEqual([
            { slug: "chat-3" },
            { slug: "chat" },
            { slug: "fight-scene" },
            { slug: "chat-2" },
          ]);
        },
      });
    });

    it("deletes working-set rows whose routes predate stable identity", {
      timeout: 90_000,
    }, async () => {
      const ids = {
        user: "00000000-0000-4000-8000-000000000221",
        project: "00000000-0000-4000-8000-000000000222",
      };
      await withPopulatedMigrationDatabase({
        databaseUrl,
        seedBefore: "0080_reset_working_set_routes",
        seed: async (target) => {
          await target.unsafe(`
            INSERT INTO users (id, external_id, email)
            VALUES ('${ids.user}', 'working-set-reset-fixture', 'working-set-reset@test.invalid');
            INSERT INTO projects (id, user_id, name, slug)
            VALUES ('${ids.project}', '${ids.user}', 'Working set reset', 'working-set-reset');
            INSERT INTO project_user_working_sets (user_id, project_id, recent_routes)
            VALUES ('${ids.user}', '${ids.project}', '[{"scheme":"kb","path":"/old.md"}]');
          `);
        },
        verify: async (target) => {
          const [{ count }] = await target<{ count: string }[]>`
            SELECT count(*)::text AS count FROM project_user_working_sets
            WHERE project_id = ${ids.project}
          `;
          expect(count).toBe("0");
        },
      });
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
    it("preserves active Work handles while reserving disambiguated deleted handles", {
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
          expect(slugs.get(ids.deletedFirst)).toBe("book-2-3");
          expect(slugs.get(ids.deletedLast)).toBe("book-2-4");
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
