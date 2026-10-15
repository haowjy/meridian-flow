/**
 * Populated upgrade contract for 0046/0047: every chat starts in its primary Work's mode, the
 * Work's mode survives its rename to the default, and a control body may carry a mode switch.
 * Run identity adds no backfill: an old lease keeps its id but is never an open execution, and
 * a message delivered before the upgrade reads as delivered by an unknown turn.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb } from "@meridian/database";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../../../tools/dev/lib/migration-runner.js";
import { createDrizzleRunClaim } from "../domains/runtime/adapters/drizzle-run-claim.js";
import { createDrizzleRepositoriesForTest } from "../domains/threads/adapters/drizzle/repositories.js";
import {
  createScratchDatabase,
  journalIndex,
  MIGRATIONS,
  readJournal,
  stageThrough,
} from "./staged-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" && Boolean(databaseUrl);
const id = (n: number) => `73900000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Rows in the 0045 shape (after the Work-branch foundation and its draft-review follow-ups): the mode lives on the Work only. */
async function seedWorkModeShape(sql: postgres.Sql) {
  await sql`INSERT INTO users (id, external_id, email) VALUES (${id(1)}, 'chat-mode-upgrade', 'chat-mode@example.test')`;
  await sql`INSERT INTO projects (id, user_id, name, slug) VALUES (${id(2)}, ${id(1)}, 'Upgrade', 'upgrade')`;
  await sql`INSERT INTO works (id, project_id, created_by_user_id, name, slug, is_no_work, ai_write_mode) VALUES
    (${id(3)}, ${id(2)}, ${id(1)}, 'No Work', NULL, true, 'draft'),
    (${id(4)}, ${id(2)}, ${id(1)}, 'Drafting', 'drafting', false, 'draft'),
    (${id(5)}, ${id(2)}, ${id(1)}, 'Live', 'live', false, 'direct')`;
  // 10 drafts; 11 was deleted with it; 12 is 10's subagent; 13 was rebound from the drafting
  // Work to the live one; 14 has no membership; 15 is a No Work chat.
  await sql`INSERT INTO threads (id, project_id, root_thread_id, created_by_user_id, deleted_at) VALUES
    (${id(10)}, ${id(2)}, ${id(10)}, ${id(1)}, NULL),
    (${id(11)}, ${id(2)}, ${id(11)}, ${id(1)}, '2026-09-01T00:00:00Z'),
    (${id(13)}, ${id(2)}, ${id(13)}, ${id(1)}, NULL),
    (${id(14)}, ${id(2)}, ${id(14)}, ${id(1)}, NULL),
    (${id(15)}, ${id(2)}, ${id(15)}, ${id(1)}, NULL)`;
  await sql`INSERT INTO turns (id, thread_id, position, role, origin, status) VALUES (${id(20)}, ${id(10)}, 1, 'assistant', 'assistant', 'complete')`;
  await sql`INSERT INTO threads (id, project_id, root_thread_id, created_by_user_id, kind, parent_thread_id, origin_type, origin_turn_id, spawn_status, spawn_depth) VALUES
    (${id(12)}, ${id(2)}, ${id(10)}, ${id(1)}, 'subagent', ${id(10)}, 'spawn', ${id(20)}, 'running', 1)`;
  await sql`INSERT INTO thread_works (thread_id, work_id, project_id, is_primary) VALUES
    (${id(10)}, ${id(4)}, ${id(2)}, true),
    (${id(11)}, ${id(4)}, ${id(2)}, true),
    (${id(12)}, ${id(4)}, ${id(2)}, true),
    (${id(13)}, ${id(4)}, ${id(2)}, false),
    (${id(13)}, ${id(5)}, ${id(2)}, true),
    (${id(15)}, ${id(3)}, ${id(2)}, true)`;
  // Chat 10 answered a delivered message M (21) and still has the stale lease that bound its
  // reply, plus the admission that steered M into it.
  await sql`INSERT INTO turns (id, thread_id, position, parent_turn_id, role, origin, status) VALUES
    (${id(21)}, ${id(10)}, 2, ${id(20)}, 'user', 'writer', 'complete'),
    (${id(22)}, ${id(10)}, 3, ${id(21)}, 'assistant', 'assistant', 'complete')`;
  await sql`INSERT INTO thread_inbox_messages (id, thread_id, intent, provenance, body, idempotency_key, delivered_at)
    VALUES (${id(21)}, ${id(10)}, 'message', ${sql.json({ kind: "writer", actorId: id(1) })},
      ${sql.json({ kind: "text", text: "M" })}, 'old-m', now())`;
  await sql`INSERT INTO thread_run_leases (thread_id, run_id, turn_id, bound_turn_ids, holder_id, expires_at)
    VALUES (${id(10)}, 'run-before-identity', ${id(22)}, ${[id(22)]}, 'old-worker', now() - interval '1 minute')`;
  await sql`INSERT INTO user_turn_admissions (thread_id, submission_id, actor_user_id, state, user_turn_id, assistant_turn_id)
    VALUES (${id(10)}, 'old-submission', ${id(1)}, 'accepted', ${id(21)}, ${id(20)})`;
}

describe.skipIf(!enabled)("chat write mode migration (postgres)", () => {
  it("copies each chat's primary Work mode and keeps the Work's as its default", async () => {
    const scratch = await createScratchDatabase(databaseUrl ?? "", "chat_mode_upgrade");
    const target = scratch.sql;
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-chat-mode-upgrade-"));
    try {
      const journal = await readJournal();
      const first = journalIndex(journal, "0046_d62_chat_write_mode");
      await stageThrough(MIGRATIONS, directory, journal, first);
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });
      await seedWorkModeShape(target);
      await rm(directory, { recursive: true, force: true });
      await stageThrough(MIGRATIONS, directory, journal, journal.entries.length);
      await runMigrations({ databaseUrl: scratch.url, migrationsDirectory: directory });

      expect(await target`SELECT id, default_ai_write_mode FROM works ORDER BY id`).toEqual([
        { id: id(3), default_ai_write_mode: "draft" },
        { id: id(4), default_ai_write_mode: "draft" },
        { id: id(5), default_ai_write_mode: "direct" },
      ]);
      expect(await target`SELECT id, ai_write_mode FROM threads ORDER BY id`).toEqual([
        { id: id(10), ai_write_mode: "draft" },
        { id: id(11), ai_write_mode: "draft" },
        { id: id(12), ai_write_mode: "draft" },
        { id: id(13), ai_write_mode: "direct" },
        { id: id(14), ai_write_mode: "direct" },
        { id: id(15), ai_write_mode: "draft" },
      ]);
      expect(
        await target`SELECT conname FROM pg_constraint
          WHERE connamespace = 'public'::regnamespace AND NOT convalidated`,
      ).toEqual([]);

      const control = (key: string, body: Record<string, string>) =>
        target`INSERT INTO thread_inbox_messages (thread_id, intent, provenance, body, idempotency_key)
          VALUES (${id(10)}, 'control', ${target.json({ kind: "writer" })}, ${target.json(body)}, ${key})`;
      // Renamed values survive; nothing is backfilled.
      expect(
        await target`SELECT execution_id, turn_id FROM thread_run_leases WHERE thread_id = ${id(10)}`,
      ).toEqual([{ execution_id: "run-before-identity", turn_id: id(22) }]);
      expect(
        await target`SELECT steers_turn_id FROM user_turn_admissions WHERE submission_id = 'old-submission'`,
      ).toEqual([{ steers_turn_id: id(20) }]);
      expect(
        await target`SELECT id, execution_id, reserved_for_user_turn_ids FROM turns
          WHERE thread_id = ${id(10)} ORDER BY position`,
      ).toEqual([
        { id: id(20), execution_id: null, reserved_for_user_turn_ids: null },
        { id: id(21), execution_id: null, reserved_for_user_turn_ids: null },
        { id: id(22), execution_id: null, reserved_for_user_turn_ids: null },
      ]);
      // The runtime's reads: the old lease is no open execution, M is delivered by an unknown turn.
      const db = createDb(scratch.url, { max: 1 });
      try {
        expect(await createDrizzleRunClaim(db).readOpenExecutionId(id(10) as never)).toBeNull();
        const deliveries = await createDrizzleRepositoriesForTest(db).turns.listMessageDeliveries(
          id(10) as never,
        );
        expect(deliveries.get(id(21))).toEqual({ byTurnId: null });
      } finally {
        await db.close();
      }

      await control("switch", { kind: "write_mode", mode: "direct" });
      await control("compact", { kind: "compact" });
      await expect(control("bad-mode", { kind: "write_mode", mode: "live" })).rejects.toMatchObject(
        { code: "23514" },
      );
      await expect(
        target`UPDATE threads SET ai_write_mode = 'live' WHERE id = ${id(10)}`,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await scratch.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
