/** Fresh-baseline catalog and bootstrap contracts on runner-owned PostgreSQL. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!enabled || !databaseUrl) {
  describe.skip("fresh database migrations (postgres)", () => {});
} else {
  describe("fresh database migrations (postgres)", () => {
    it("installs the baseline and ordered journal entries", async () => {
      const journal = JSON.parse(
        await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
      ) as { entries: Array<{ idx: number; tag: string; when: number }> };
      expect(journal.entries[0]).toMatchObject({ idx: 0, tag: "0000_baseline" });
      for (let index = 1; index < journal.entries.length; index += 1) {
        expect(journal.entries[index]?.when).toBeGreaterThan(journal.entries[index - 1]?.when ?? 0);
      }
      const baseline = await readFile(new URL("./migrations/0000_baseline.sql", import.meta.url));
      const target = postgres(databaseUrl, { max: 1 });
      try {
        const applied =
          await target`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
        expect(applied).toHaveLength(journal.entries.length);
        expect(applied[0]).toEqual({
          hash: createHash("sha256").update(baseline).digest("hex"),
          created_at: String(journal.entries[0]?.when),
        });
      } finally {
        await target.end();
      }
    });
    it("exposes the expected catalog on the runner-migrated database", async () => {
      const target = postgres(databaseUrl, { max: 1 });
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
        const functions = await target<{ name: string }[]>`
          SELECT p.proname AS name FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND NOT EXISTS (
              SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                AND d.objid = p.oid AND d.deptype = 'e'
            )
          ORDER BY name
        `;
        expect(functions.map((row) => row.name)).toEqual([
          "complete_turn_trail_work",
          "consume_credit_lots_fifo",
          "enforce_thread_prompt_freeze",
          "enlist_turn_trail_work",
          "update_updated_at_column",
          "validate_active_leaf_is_leaf",
          "validate_active_leaf_same_thread",
          "validate_parent_turn_links_same_thread",
          "validate_parent_turn_same_thread",
        ]);
        expect(await target`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`).toEqual([
          { extname: "pg_trgm" },
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
    it("supports locked No Work and primary thread bindings without seeded identities", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      try {
        await target.begin(async (tx) => {
          const [user] = await tx`INSERT INTO users (external_id, email)
            VALUES ('baseline-no-work', 'baseline-no-work@example.test') RETURNING id`;
          const [project] = await tx`INSERT INTO projects (user_id, name, slug)
            VALUES (${user.id}, 'Baseline', 'baseline') RETURNING id`;
          // Projects created after migration are bootstrapped by the application, not a trigger.
          expect(await tx`SELECT id FROM works WHERE project_id = ${project.id}`).toEqual([]);
          const [work] =
            await tx`INSERT INTO works (project_id, created_by_user_id, name, is_no_work)
            VALUES (${project.id}, ${user.id}, 'No Work', true)
            RETURNING id, slug, status, ai_write_mode`;
          expect(work).toMatchObject({ slug: null, status: "active", ai_write_mode: "direct" });
          await expect(
            tx.savepoint(
              (save) => save`UPDATE works SET status = 'archived' WHERE id = ${work.id}`,
            ),
          ).rejects.toMatchObject({ constraint_name: "works_no_work_active" });
          await expect(
            tx.savepoint((save) => save`UPDATE works SET slug = 'named' WHERE id = ${work.id}`),
          ).rejects.toMatchObject({ constraint_name: "works_no_work_slug" });
          await expect(
            tx.savepoint(
              (save) => save`INSERT INTO works (project_id, created_by_user_id, name, is_no_work)
            VALUES (${project.id}, ${user.id}, 'Another No Work', true)`,
            ),
          ).rejects.toMatchObject({ constraint_name: "works_project_no_work_active" });
          const [thread] = await tx`INSERT INTO threads (project_id, created_by_user_id)
            VALUES (${project.id}, ${user.id}) RETURNING id`;
          await tx`INSERT INTO thread_works (thread_id, work_id, project_id, is_primary)
            VALUES (${thread.id}, ${work.id}, ${project.id}, true)`;
          expect(
            await tx`SELECT work_id, is_primary FROM thread_works WHERE thread_id = ${thread.id}`,
          ).toEqual([{ work_id: work.id, is_primary: true }]);
          await tx`DELETE FROM users WHERE id = ${user.id}`;
        });
      } finally {
        await target.end();
      }
    });
    it("applies the post-migrate FIFO function with replay-safe debits", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      try {
        await target.begin(async (tx) => {
          const [user] = await tx`INSERT INTO users (external_id, email)
            VALUES ('baseline-functions', 'baseline-functions@example.test') RETURNING id`;
          await tx`INSERT INTO credit_lots (user_id, original_amount_millicredits, remaining_millicredits, source_type, grant_reason)
            VALUES (${user.id}, 100, 100, 'grant', 'baseline-probe')`;
          const first =
            await tx`SELECT * FROM consume_credit_lots_fifo(${user.id}::uuid, 30, gen_random_uuid(), 'baseline-usage')`;
          expect(first).toEqual([
            {
              remaining_balance: "70",
              went_negative: false,
              consumption_group_id: expect.any(String),
            },
          ]);
          expect(
            await tx`SELECT * FROM consume_credit_lots_fifo(${user.id}::uuid, 30, gen_random_uuid(), 'baseline-usage')`,
          ).toEqual(first);
          expect(
            await tx`SELECT amount_millicredits FROM credit_transactions WHERE user_id = ${user.id}`,
          ).toEqual([{ amount_millicredits: "-30" }]);
          await tx`DELETE FROM users WHERE id = ${user.id}`;
        });
      } finally {
        await target.end();
      }
    });
  });
}
