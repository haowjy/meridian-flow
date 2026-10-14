/**
 * DB-suite hooks that pin run-state publication. `installPublicationAudit` adds a test-only trigger
 * audit to the throwaway test database (never a migration); after each scenario `assertPublicationHooks`
 * checks that
 *
 * - every transaction that changed an input of a chat's record also appended a `run_state.changed`
 *   row for that chat (a write a later publish masks can't pass parity alone), and
 * - the chat's last journaled record equals a fresh `readRunState` (a record that disagrees with its
 *   rows, or a chat with input rows and no record, fails).
 */
import { isDeepStrictEqual } from "node:util";
import type { Database } from "@meridian/database";
import * as schema from "@meridian/database/schema";
import { sql } from "drizzle-orm";
import { readRunState } from "../domains/runtime/adapters/drizzle-run-state.js";

export async function installPublicationAudit(db: Database) {
  await db.execute(sql`CREATE UNLOGGED TABLE IF NOT EXISTS run_state_audit (
    txid bigint NOT NULL, thread_id uuid NOT NULL, kind text NOT NULL)`);
  await db.execute(sql`CREATE OR REPLACE FUNCTION run_state_audit_input() RETURNS trigger AS $$
    DECLARE tid uuid; BEGIN
      IF TG_TABLE_NAME = 'thread_inbox_messages' THEN
        IF NEW.body->>'kind' = 'work_context_refresh' THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND OLD.delivered_at IS NOT DISTINCT FROM NEW.delivered_at THEN RETURN NEW; END IF;
        tid := NEW.thread_id;
      ELSIF TG_TABLE_NAME = 'thread_run_leases' THEN
        IF TG_OP = 'DELETE' THEN
          IF OLD.turn_id IS NULL AND cardinality(OLD.adopted_message_ids) = 0 THEN RETURN OLD; END IF;
          tid := OLD.thread_id;
        ELSE
          IF NEW.turn_id IS NOT DISTINCT FROM OLD.turn_id
            AND NEW.adopted_message_ids IS NOT DISTINCT FROM OLD.adopted_message_ids THEN RETURN NEW; END IF;
          tid := NEW.thread_id;
        END IF;
      ELSE
        IF NEW.ai_write_mode IS NOT DISTINCT FROM OLD.ai_write_mode
          AND NEW.inbox_blocked_reason IS NOT DISTINCT FROM OLD.inbox_blocked_reason THEN RETURN NEW; END IF;
        tid := NEW.id;
      END IF;
      INSERT INTO run_state_audit VALUES (txid_current(), tid, 'input');
      RETURN COALESCE(NEW, OLD);
    END $$ LANGUAGE plpgsql`);
  await db.execute(sql`CREATE OR REPLACE FUNCTION run_state_audit_record() RETURNS trigger AS $$
    BEGIN
      IF NEW.event_type = 'run_state.changed' THEN
        INSERT INTO run_state_audit VALUES (txid_current(), NEW.thread_id, 'record');
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  const triggers: Array<[string, string, string, string]> = [
    ["run_state_audit_inbox", "thread_inbox_messages", "INSERT OR UPDATE", "run_state_audit_input"],
    ["run_state_audit_lease", "thread_run_leases", "UPDATE OR DELETE", "run_state_audit_input"],
    ["run_state_audit_threads", "threads", "UPDATE", "run_state_audit_input"],
    ["run_state_audit_journal", "event_journal", "INSERT", "run_state_audit_record"],
  ];
  for (const [name, table, events, fn] of triggers) {
    await db.execute(
      sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}; CREATE TRIGGER ${name} AFTER ${events}
        ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`),
    );
  }
}

export async function assertPublicationHooks(db: Database) {
  const unpublished = await db.execute<{ txid: string; thread_id: string }>(sql`
    SELECT DISTINCT i.txid::text, i.thread_id FROM run_state_audit i
    WHERE i.kind = 'input'
      AND EXISTS (SELECT 1 FROM threads t WHERE t.id = i.thread_id)
      AND NOT EXISTS (SELECT 1 FROM run_state_audit r
        WHERE r.kind = 'record' AND r.txid = i.txid AND r.thread_id = i.thread_id)`);
  await db.execute(sql`TRUNCATE run_state_audit`);
  if (unpublished.length > 0)
    throw new Error(
      `Transactions changed run-state inputs without publishing a record: ${JSON.stringify(unpublished)}`,
    );

  const chats = await db.select({ id: schema.threads.id }).from(schema.threads);
  for (const { id } of chats) {
    const [last] = await db.execute<{ run_state: unknown }>(sql`
      SELECT payload->'runState' AS run_state FROM event_journal
      WHERE thread_id = ${id} AND event_type = 'run_state.changed' ORDER BY seq DESC LIMIT 1`);
    const fresh = await readRunState(db, id);
    const quiet = {
      items: [],
      sentThrough: 0,
      execution: null,
      mode: "direct",
      blocked: null,
    };
    // jsonb reorders keys, so compare structurally.
    if (!isDeepStrictEqual(last?.run_state ?? quiet, JSON.parse(JSON.stringify(fresh))))
      throw new Error(
        `Run state of ${id} disagrees with its rows: record ${JSON.stringify(last?.run_state ?? null)}, rows ${JSON.stringify(fresh)}`,
      );
  }
}
