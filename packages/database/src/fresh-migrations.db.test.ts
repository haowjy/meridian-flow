/** Migration-chain catalog proof against the runner-owned fresh PostgreSQL database. */
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

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

    it("rewrites legacy trail evidence into one writer-impact authority", async () => {
      const target = postgres(databaseUrl, { max: 1 });
      const migration = await readFile(
        new URL("./migrations/0062_writer_impact.sql", import.meta.url),
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
        beforeBlockId: "before",
        afterBlockId: null,
        beforeText: "before|body",
        afterTextAtReceipt: null,
        navigation: { kind: "unavailable", reason: "fixture" },
        reversible: false,
      };
      const changes = [
        {
          ...base,
          changeId: "sweep",
          swept: {
            affectedBlockHash: "hash",
            affectedBlockIdentity: { documentId: "document", clientID: 1, clock: 2 },
            removed: { status: "available", markdown: "fallback" },
            beforeContentRef: null,
          },
          writerProtection: {
            kind: "sweep",
            body: { status: "available", markdown: "writer body" },
            ranges: [{ clientID: 1, clock: 2, length: 3 }],
          },
        },
        {
          ...base,
          changeId: "resurrection",
          swept: null,
          writerProtection: {
            kind: "resurrection",
            body: { status: "available", markdown: "restored" },
          },
        },
        { ...base, changeId: "ordinary", swept: null },
      ];
      try {
        await target.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await target.unsafe(`CREATE SCHEMA ${schema}`);
        await target.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
          await tx.unsafe(`
            CREATE TABLE change_trail_document_details (changes jsonb NOT NULL);
            CREATE TABLE change_trail_delivery_outbox (
              event_kind text NOT NULL,
              change_count integer,
              swept_change_count integer,
              document_count integer,
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
          `);
          await tx`
            INSERT INTO change_trail_document_details (changes)
            VALUES (${tx.json(changes)})
          `;
          await tx.unsafe(migration);

          const [row] = await tx<{ changes: typeof changes }[]>`
            SELECT changes FROM change_trail_document_details
          `;
          expect(row?.changes).toEqual([
            {
              ...base,
              changeId: "sweep",
              writerImpact: {
                kind: "sweep",
                affectedBlockHash: "hash",
                affectedBlockIdentity: { documentId: "document", clientID: 1, clock: 2 },
                body: { status: "available", markdown: "writer body" },
                beforeContentRef: null,
                ranges: [{ clientID: 1, clock: 2, length: 3 }],
              },
            },
            {
              ...base,
              changeId: "resurrection",
              writerImpact: {
                kind: "resurrection",
                body: { status: "available", markdown: "restored" },
              },
            },
            { ...base, changeId: "ordinary", writerImpact: null },
          ]);
          const columns = await tx<{ table_name: string; column_name: string }[]>`
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = ${schema}
              AND table_name IN ('change_trail_delivery_outbox', 'change_trail_shells')
              AND column_name LIKE '%impact_count'
            ORDER BY table_name
          `;
          expect(columns).toEqual([
            {
              table_name: "change_trail_delivery_outbox",
              column_name: "writer_impact_count",
            },
            { table_name: "change_trail_shells", column_name: "writer_impact_count" },
          ]);
        });
      } finally {
        await target.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await target.end();
      }
    });
  });
}
