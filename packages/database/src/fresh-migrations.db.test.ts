/** Migration-chain catalog proof against the runner-owned fresh PostgreSQL database. */
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { withPopulatedMigrationDatabase } from "./__test-support__/migration-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!enabled || !databaseUrl) {
  describe.skip("fresh database migrations (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
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
      } finally {
        await target.end();
      }
    });

    it("upgrades populated publication lineage without losing its generation", async () => {
      await withPopulatedMigrationDatabase({
        databaseUrl,
        seedBefore: "0065_secret_red_ghost",
        seed: async (target) => {
          await target.unsafe(`
            INSERT INTO users (id, external_id, email)
            VALUES (
              '00000000-0000-4000-8000-000000000001',
              'populated-migration-fixture',
              'populated-migration@test.invalid'
            );
            INSERT INTO projects (id, user_id, name, slug)
            VALUES (
              '00000000-0000-4000-8000-000000000002',
              '00000000-0000-4000-8000-000000000001',
              'Migration fixture',
              'migration-fixture'
            );
            INSERT INTO works (id, project_id, created_by_user_id)
            VALUES (
              '00000000-0000-4000-8000-000000000003',
              '00000000-0000-4000-8000-000000000002',
              '00000000-0000-4000-8000-000000000001'
            );
            INSERT INTO context_sources (id, project_id, name, slug)
            VALUES (
              '00000000-0000-4000-8000-000000000004',
              '00000000-0000-4000-8000-000000000002',
              'Migration fixture',
              'migration-fixture'
            );
            INSERT INTO documents (id, context_source_id, name)
            VALUES (
              '00000000-0000-4000-8000-000000000005',
              '00000000-0000-4000-8000-000000000004',
              'migration-fixture'
            );
            INSERT INTO document_branches (
              id, document_id, kind, work_id, state, state_vector, schema_version, generation
            )
            VALUES (
              'migration-fixture-branch',
              '00000000-0000-4000-8000-000000000005',
              'work_draft',
              '00000000-0000-4000-8000-000000000003',
              '\\x00',
              '\\x00',
              1,
              7
            );
            INSERT INTO push_lineage (
              branch_id, document_id, push_kind, journal_ids, receipt_payload, idempotency_key
            )
            VALUES (
              'migration-fixture-branch',
              '00000000-0000-4000-8000-000000000005',
              'whole',
              '{}',
              '{"branchGeneration": 7}',
              'populated-migration-fixture'
            );
          `);
        },
        verify: async (target) => {
          const rows = await target<{ branch_generation: number }[]>`
            SELECT branch_generation
            FROM push_lineage
            WHERE idempotency_key = 'populated-migration-fixture'
          `;
          expect(rows).toEqual([{ branch_generation: 7 }]);
        },
      });
    }, 120_000);

    it("refuses to invent publication generations when legacy evidence is missing", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      const migration = await readFile(
        new URL("./migrations/0065_secret_red_ghost.sql", import.meta.url),
        "utf8",
      );
      const schema = "push_lineage_migration_fixture";
      try {
        await target.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await expect(
          target.begin(async (tx) => {
            await tx.unsafe(`CREATE SCHEMA ${schema}`);
            await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
            await tx.unsafe(`
              CREATE TABLE push_lineage (
                branch_id text,
                push_kind text NOT NULL,
                receipt_payload jsonb
              );
              CREATE INDEX push_lineage_branch ON push_lineage (branch_id);
              INSERT INTO push_lineage (push_kind, receipt_payload) VALUES ('whole', NULL);
            `);
            await tx.unsafe(migration);
          }),
        ).rejects.toThrow("push_lineage contains rows without a recoverable branchGeneration");
      } finally {
        await target.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await target.end();
      }
    });

    it("deletes branch-local writer-impact storage", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      const migration = await readFile(
        new URL("./migrations/0064_writer_impact.sql", import.meta.url),
        "utf8",
      );
      const schema = "writer_impact_migration_fixture";
      const base = {
        changeId: "change",
        ordinal: 0,
        documentId: "document",
        pushId: "1",
        receiptId: "receipt",
        kind: "delete",
        beforeText: "before|body",
        afterTextAtReceipt: null,
        beforeBlockIdentity: null,
        afterBlockIdentity: null,
        navigation: { kind: "unavailable", reason: "fixture" },
      };
      const changes = [
        {
          ...base,
          forwardActions: {
            restore: { status: "settled", outcome: "anchor_unavailable" },
            "delete-again": { status: "settled", outcome: "anchor_unavailable" },
          },
          restore: { status: "settled", outcome: "anchor_unavailable" },
          swept: { affectedBlockHash: "hash" },
          writerProtection: { kind: "sweep" },
          writerImpact: { kind: "sweep" },
        },
      ];
      try {
        await target.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await target.unsafe(`CREATE SCHEMA ${schema}`);
        await target.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
          await tx.unsafe(`
            CREATE TABLE change_trail_document_details (changes jsonb NOT NULL);
            CREATE TABLE change_trail_delivery_outbox (
              change_count integer NOT NULL,
              swept_change_count integer NOT NULL,
              document_count integer NOT NULL,
              CONSTRAINT change_trail_delivery_outbox_counts_valid CHECK (true)
            );
            CREATE TABLE change_trail_shells (
              state text NOT NULL,
              version integer NOT NULL,
              change_count integer NOT NULL,
              swept_change_count integer NOT NULL,
              document_count integer NOT NULL,
              settled_at timestamptz,
              CONSTRAINT change_trail_shells_state_counts_valid CHECK (true)
            );
            CREATE TABLE branch_push_settlement_outbox (before_content_ref bigint);
          `);
          await tx`
            INSERT INTO change_trail_document_details (changes)
            VALUES (${tx.json(changes)})
          `;
          await tx.unsafe(migration);

          const [row] = await tx<{ changes: unknown }[]>`
            SELECT changes FROM change_trail_document_details
          `;
          expect(row?.changes).toEqual([base]);
          const removedColumns = await tx<{ column_name: string }[]>`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = ${schema}
              AND column_name IN ('swept_change_count', 'writer_impact_count', 'before_content_ref')
          `;
          expect(removedColumns).toEqual([]);
        });
      } finally {
        await target.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await target.end();
      }
    });
  });
}
