/** Migration-chain catalog proof against the runner-owned fresh PostgreSQL database. */
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

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
  });
}
