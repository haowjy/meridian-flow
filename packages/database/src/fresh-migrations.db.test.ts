/**
 * Fresh-baseline catalog and bootstrap contracts on runner-owned PostgreSQL.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - baseline journal hashes and database-enforced locked No Work bootstrap constraints (kb/decisions/platform/stack/drizzle-migration-integrity.md)
 */
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
            RETURNING id, handle, status, archived_at, default_ai_write_mode`;
          expect(work).toMatchObject({
            handle: null,
            status: null,
            archived_at: null,
            default_ai_write_mode: "direct",
          });
          await expect(
            tx.savepoint(
              (save) => save`UPDATE works SET archived_at = now() WHERE id = ${work.id}`,
            ),
          ).rejects.toMatchObject({ constraint_name: "works_no_work_not_archived" });
          await expect(
            tx.savepoint((save) => save`UPDATE works SET handle = 'w1' WHERE id = ${work.id}`),
          ).rejects.toMatchObject({ constraint_name: "works_no_work_handle" });
          await expect(
            tx.savepoint(
              (save) => save`INSERT INTO works (project_id, created_by_user_id, name, is_no_work)
            VALUES (${project.id}, ${user.id}, 'Another No Work', true)`,
            ),
          ).rejects.toMatchObject({ constraint_name: "works_project_no_work_active" });
          const threadId = crypto.randomUUID();
          const [thread] =
            await tx`INSERT INTO threads (id, root_thread_id, project_id, created_by_user_id)
            VALUES (${threadId}, ${threadId}, ${project.id}, ${user.id}) RETURNING id`;
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
    it("keeps lineage Scratch independent of the first chat row and enforces its owner shape", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      try {
        await target.begin(async (tx) => {
          const [user] =
            await tx`INSERT INTO users (external_id, email) VALUES ('lineage-shape', 'lineage-shape@example.test') RETURNING id`;
          const [project] =
            await tx`INSERT INTO projects (user_id, name, slug) VALUES (${user.id}, 'Lineage', 'lineage') RETURNING id`;
          const root = crypto.randomUUID();
          await tx`INSERT INTO threads (id, root_thread_id, project_id, created_by_user_id, ref) VALUES (${root}, ${root}, ${project.id}, ${user.id}, 'c12')`;
          const [source] =
            await tx`INSERT INTO context_sources (project_id, root_thread_id, scope, name, slug) VALUES (${project.id}, ${root}, 'lineage', 'Scratch', 'scratch') RETURNING id`;
          await expect(
            tx.savepoint(
              (save) =>
                save`INSERT INTO context_sources (project_id, root_thread_id, scope, name, slug) VALUES (${project.id}, ${root}, 'lineage', 'Uploads', 'uploads')`,
            ),
          ).rejects.toMatchObject({ constraint_name: "context_sources_exactly_one_scope" });
          await tx`DELETE FROM threads WHERE id = ${root}`;
          expect(await tx`SELECT id FROM context_sources WHERE id = ${source.id}`).toEqual([
            { id: source.id },
          ]);
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
