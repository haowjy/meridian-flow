/**
 * DB-suite hooks that pin run-state publication. `openAuditedDatabase` clones a disposable database
 * from the run's migrated template and installs a test-only trigger audit in it (never a migration,
 * never in the worker's shared database); `close` drops it. After each scenario `assertPublicationHooks`
 * checks that
 *
 * - every transaction that changed an input of a chat's record also appended a `run_state.changed`
 *   row for that chat (a write a later publish masks can't pass parity alone), and
 * - the chat's last journaled record equals a fresh `readRunState` (a record that disagrees with its
 *   rows, or a chat with input rows and no record, fails).
 */

import { randomInt } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createDb, type Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { readRunState } from "../domains/runtime/adapters/drizzle-run-state.js";

// A suite that drains detached work (up to 8 s) and then closes must fit the 30 s hook timeout:
// 8 + 12 + 3 + 3 = 26 s.
const DROP_TIMEOUT_MS = 12_000;
const POOL_CLOSE_TIMEOUT_MS = 3_000;

/**
 * Waits for `work` at most `ms`. Cleanup must not hang or fail a suite, but it must not hide a
 * failure either: a step that errors or runs out of time is warned about, by name.
 */
async function within(ms: number, step: string, work: Promise<unknown> | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      (work ?? Promise.resolve()).then(
        () => "done" as const,
        (error: unknown) => error,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
    if (outcome !== "done")
      process.stderr.write(
        `[audited-db] ${step} ${outcome === "timeout" ? `did not finish in ${ms} ms` : `failed: ${String(outcome)}`}\n`,
      );
  } finally {
    clearTimeout(timer);
  }
}

export type AuditedDatabase = { db: Database; close: () => Promise<void> };

/**
 * A disposable database owned by one suite: cloned from the managed run's template (which no session
 * connects to, so the clone cannot be blocked), audited, and dropped by `close`. The name keeps the
 * managed `<template>-worker-<n>` shape (`n` far above any worker index), so the run's managed cleanup
 * collects a clone that a crash or a failed drop left, by the `<template>-worker-` prefix.
 */
export async function openAuditedDatabase(
  workerUrl: string,
  options: { max: number },
): Promise<AuditedDatabase> {
  const workerName = decodeURIComponent(new URL(workerUrl).pathname.slice(1));
  const managed = /_test-run-\d+-\d+-worker-\d+$/.test(workerName);
  const templateName = managed ? workerName.replace(/-worker-\d+$/, "") : workerName;
  const cloneName = managed
    ? `${templateName}-worker-${randomInt(1000, 1_000_000)}`
    : `${workerName}_audit_${process.pid}_${Date.now()}`;
  if (Buffer.byteLength(cloneName) > 63)
    throw new Error(`Audit database name is longer than 63 bytes: ${cloneName}`);
  const urlFor = (name: string) => {
    const url = new URL(workerUrl);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const admin = postgres(urlFor("postgres"), { max: 1 });
  let db: Database | undefined;
  // Cleanup must never hang a suite. Managed local runs collect every clone after Vitest exits;
  // dropping several audited clones from parallel workers here makes PostgreSQL serialize checkpoints
  // and charges that wait to the test files. CI has no managed collector, so it drops its serial
  // clone after closing the pool. FORCE still ends a query whose bounded pool close timed out.
  const close = async () => {
    await within(POOL_CLOSE_TIMEOUT_MS, `closing the pool of ${cloneName}`, db?.close());
    if (!managed)
      await within(
        DROP_TIMEOUT_MS,
        `dropping ${cloneName}`,
        admin.unsafe(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`),
      );
    await within(
      POOL_CLOSE_TIMEOUT_MS,
      `closing the admin connection for ${cloneName}`,
      admin.end({ timeout: 1 }),
    );
  };
  try {
    await admin.unsafe(`CREATE DATABASE "${cloneName}" WITH TEMPLATE "${templateName}"`);
    db = createDb(urlFor(cloneName), { max: options.max });
    await installPublicationAudit(db);
    return { db, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

async function installPublicationAudit(db: Database) {
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
  const audited = await db.execute<{
    thread_id: string;
    run_state: unknown;
    unpublished: boolean;
  }>(sql`
    WITH affected AS (
      SELECT DISTINCT thread_id FROM run_state_audit
    )
    SELECT
      affected.thread_id,
      (SELECT payload->'runState' FROM event_journal
        WHERE thread_id = affected.thread_id AND event_type = 'run_state.changed'
        ORDER BY seq DESC LIMIT 1) AS run_state,
      EXISTS (
        SELECT 1 FROM run_state_audit i
        WHERE i.thread_id = affected.thread_id
          AND i.kind = 'input'
          AND NOT EXISTS (SELECT 1 FROM run_state_audit r
            WHERE r.kind = 'record' AND r.txid = i.txid AND r.thread_id = i.thread_id)
      ) AS unpublished
    FROM affected
    WHERE EXISTS (SELECT 1 FROM threads WHERE id = affected.thread_id)`);
  await db.execute(sql`TRUNCATE run_state_audit`);
  const unpublished = audited.filter((row) => row.unpublished);
  if (unpublished.length > 0)
    throw new Error(
      `Transactions changed run-state inputs without publishing a record for threads: ${JSON.stringify(unpublished.map((row) => row.thread_id))}`,
    );

  for (const row of audited) {
    const fresh = await readRunState(db, row.thread_id);
    const quiet = {
      items: [],
      sentThrough: 0,
      execution: null,
      mode: "direct",
      blocked: null,
    };
    // jsonb reorders keys, so compare structurally.
    if (!isDeepStrictEqual(row.run_state ?? quiet, JSON.parse(JSON.stringify(fresh))))
      throw new Error(
        `Run state of ${row.thread_id} disagrees with its rows: record ${JSON.stringify(row.run_state ?? null)}, rows ${JSON.stringify(fresh)}`,
      );
  }
}
