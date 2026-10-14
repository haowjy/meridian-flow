/**
 * The change trail learns that a settlement finished from the batch row: its state moves
 * off the outbox in the Work-branch foundation, and the dirty signal must follow it.
 */
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const id = (n: number) => `75700000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!enabled || !databaseUrl)("settlement dirty signal (postgres)", () => {
  it("writes dirty-log rows for a batch's outbox owners when the batch completes", async () => {
    const sql = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
    try {
      const bytes = Buffer.from([0, 0]);
      await sql
        .begin(async (tx) => {
          await tx`INSERT INTO users (id, external_id, email) VALUES (${id(1)}, 'dirty-signal', 'dirty-signal@example.test')`;
          await tx`INSERT INTO projects (id, user_id, name, slug) VALUES (${id(2)}, ${id(1)}, 'Signal', 'signal')`;
          await tx`INSERT INTO context_sources (id, project_id, name, slug) VALUES (${id(3)}, ${id(2)}, 'Manuscript', 'manuscript')`;
          await tx`INSERT INTO documents (id, context_source_id, name) VALUES (${id(4)}, ${id(3)}, 'chapter')`;
          await tx`INSERT INTO threads (id, project_id, root_thread_id, created_by_user_id) VALUES (${id(5)}, ${id(2)}, ${id(5)}, ${id(1)})`;
          await tx`INSERT INTO turns (id, thread_id, position, role, origin, status) VALUES (${id(6)}, ${id(5)}, 1, 'assistant', 'assistant', 'complete')`;
          await tx`INSERT INTO push_lineage (id, document_id, journal_ids, thread_id, turn_id, idempotency_key)
          VALUES (9001, ${id(4)}, '{}', ${id(5)}, ${id(6)}, 'dirty-signal-push')`;
          await tx`INSERT INTO branch_push_settlement_batches (id, state, claim_token, claim_kind, claimed_at, lease_expires_at)
          VALUES (${id(7)}, 'pending', ${id(8)}, 'warm', now(), now() + interval '1 minute')`;
          await tx`INSERT INTO branch_push_settlement_outbox (push_id, batch_id, document_id, document_title, lock_cut_update, push_update, trail_seed)
          VALUES (9001, ${id(7)}, ${id(4)}, 'Chapter', ${bytes}, ${bytes}, '{}')`;
          await tx`INSERT INTO documents (id, context_source_id, name) VALUES (${id(9)}, ${id(3)}, 'second')`;
          await tx`INSERT INTO threads (id, project_id, root_thread_id, created_by_user_id) VALUES (${id(10)}, ${id(2)}, ${id(10)}, ${id(1)})`;
          await tx`INSERT INTO turns (id, thread_id, position, role, origin, status) VALUES (${id(11)}, ${id(10)}, 1, 'assistant', 'assistant', 'complete')`;
          await tx`INSERT INTO push_lineage (id, document_id, journal_ids, thread_id, turn_id, idempotency_key)
          VALUES (9002, ${id(9)}, '{}', ${id(10)}, ${id(11)}, 'dirty-signal-second')`;
          await tx`INSERT INTO branch_push_settlement_outbox (push_id, batch_id, document_id, document_title, lock_cut_update, push_update, trail_seed)
          VALUES (9002, ${id(7)}, ${id(9)}, 'Second', ${bytes}, ${bytes}, '{}')`;
          const [cut] =
            await tx`SELECT coalesce(max(seq), 0)::text AS seq FROM change_trail_dirty_log`;
          await tx`UPDATE branch_push_settlement_batches
          SET state = 'completed', completed_at = now(), claim_token = NULL, claim_kind = NULL,
            claimed_at = NULL, lease_expires_at = NULL
          WHERE id = ${id(7)}`;
          const log =
            await tx`SELECT thread_id, turn_id FROM change_trail_dirty_log WHERE seq > ${cut?.seq}::bigint ORDER BY thread_id, turn_id NULLS LAST`;
          expect(log).toEqual([
            { thread_id: id(5), turn_id: id(6) },
            { thread_id: id(5), turn_id: null },
            { thread_id: id(10), turn_id: id(11) },
            { thread_id: id(10), turn_id: null },
          ]);
          throw new RollbackSeed();
        })
        .catch((error) => {
          if (!(error instanceof RollbackSeed)) throw error;
        });
    } finally {
      await sql.end();
    }
  });
});

class RollbackSeed extends Error {}
