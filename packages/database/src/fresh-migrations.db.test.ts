/** Migration-chain catalog proof against the runner-owned fresh PostgreSQL database. */
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

    it("upgrades settled delivery rows from the pre-0060 schema", async () => {
      await withPopulatedMigrationDatabase({
        databaseUrl,
        seedBefore: "0060_cultured_cobalt_man",
        seed: async (target) => {
          await target.unsafe(`
            INSERT INTO users (id, external_id, email)
            VALUES (
              '00000000-0000-4000-8000-000000000001',
              'settled-outbox-migration-fixture',
              'settled-outbox-migration@test.invalid'
            );
            INSERT INTO projects (id, user_id, name, slug)
            VALUES (
              '00000000-0000-4000-8000-000000000002',
              '00000000-0000-4000-8000-000000000001',
              'Settled outbox migration fixture',
              'settled-outbox-migration-fixture'
            );
            INSERT INTO threads (
              id, project_id, created_by_user_id, title, kind, status
            )
            VALUES
              (
                '00000000-0000-4000-8000-000000000003',
                '00000000-0000-4000-8000-000000000002',
                '00000000-0000-4000-8000-000000000001',
                'Current settled outbox migration fixture',
                'primary',
                'idle'
              ),
              (
                '00000000-0000-4000-8000-000000000008',
                '00000000-0000-4000-8000-000000000002',
                '00000000-0000-4000-8000-000000000001',
                'Historical settled outbox migration fixture',
                'primary',
                'idle'
              ),
              (
                '00000000-0000-4000-8000-000000000012',
                '00000000-0000-4000-8000-000000000002',
                '00000000-0000-4000-8000-000000000001',
                'Incomplete settled outbox migration fixture',
                'primary',
                'idle'
              );
            INSERT INTO change_trail_shells (
              id, thread_id, owner_kind, state, version, change_count,
              swept_change_count, document_count, settled_at
            )
            VALUES
              (
                '00000000-0000-4000-8000-000000000004',
                '00000000-0000-4000-8000-000000000003',
                'shared',
                'settled',
                3,
                3,
                1,
                1,
                '2026-07-26T12:00:00Z'
              ),
              (
                '00000000-0000-4000-8000-000000000005',
                '00000000-0000-4000-8000-000000000008',
                'shared',
                'building',
                4,
                9,
                4,
                2,
                NULL
              ),
              (
                '00000000-0000-4000-8000-000000000013',
                '00000000-0000-4000-8000-000000000012',
                'shared',
                'building',
                3,
                8,
                3,
                2,
                NULL
              );
            INSERT INTO change_trail_delivery_outbox (
              event_id, thread_id, trail_id, version, event_kind,
              change_count, swept_change_count, document_count
            )
            VALUES
              (
                '00000000-0000-4000-8000-000000000009',
                '00000000-0000-4000-8000-000000000003',
                '00000000-0000-4000-8000-000000000004',
                2,
                'updated',
                1,
                0,
                1
              ),
              (
                '00000000-0000-4000-8000-000000000006',
                '00000000-0000-4000-8000-000000000003',
                '00000000-0000-4000-8000-000000000004',
                3,
                'settled',
                NULL,
                NULL,
                NULL
              ),
              (
                '00000000-0000-4000-8000-000000000010',
                '00000000-0000-4000-8000-000000000008',
                '00000000-0000-4000-8000-000000000005',
                2,
                'updated',
                3,
                1,
                1
              ),
              (
                '00000000-0000-4000-8000-000000000007',
                '00000000-0000-4000-8000-000000000008',
                '00000000-0000-4000-8000-000000000005',
                3,
                'settled',
                NULL,
                NULL,
                NULL
              ),
              (
                '00000000-0000-4000-8000-000000000011',
                '00000000-0000-4000-8000-000000000008',
                '00000000-0000-4000-8000-000000000005',
                4,
                'updated',
                9,
                4,
                2
              ),
              (
                '00000000-0000-4000-8000-000000000014',
                '00000000-0000-4000-8000-000000000012',
                '00000000-0000-4000-8000-000000000013',
                2,
                'settled',
                NULL,
                NULL,
                NULL
              );
          `);
        },
        verify: async (target) => {
          const rows = await target<
            {
              event_id: string;
              change_count: number;
              swept_change_count: number;
              document_count: number;
            }[]
          >`
            SELECT event_id, change_count, swept_change_count, document_count
            FROM change_trail_delivery_outbox
            WHERE event_kind = 'settled'
            ORDER BY event_id
          `;
          expect(rows).toEqual([
            {
              event_id: "00000000-0000-4000-8000-000000000006",
              change_count: 3,
              swept_change_count: 1,
              document_count: 1,
            },
            {
              event_id: "00000000-0000-4000-8000-000000000007",
              change_count: 3,
              swept_change_count: 1,
              document_count: 1,
            },
            {
              event_id: "00000000-0000-4000-8000-000000000014",
              change_count: 0,
              swept_change_count: 0,
              document_count: 0,
            },
          ]);
        },
      });
    }, 120_000);
  });
}
