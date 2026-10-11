/**
 * Populated upgrade contract for 0039/0040: every chat starts in its primary Work's mode, the
 * Work's mode survives its rename to the default, and a control body may carry a mode switch.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../../../tools/dev/lib/migration-runner.js";
import {
  isolateSchemas,
  journalIndex,
  readMigrationJournal,
  restoreSchemas,
  stageThrough,
} from "./migration-upgrade.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" && Boolean(databaseUrl);
const id = (n: number) => `73900000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PREFIX = "chat_write_mode_upgrade";

/** Rows in the 0038 shape: the mode lives on the Work only. */
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
}

describe.skipIf(!enabled)("chat write mode migration (postgres)", () => {
  it("copies each chat's primary Work mode and keeps the Work's as its default", async () => {
    const target = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-chat-mode-upgrade-"));
    let isolated = false;
    try {
      const journal = await readMigrationJournal();
      const first = journalIndex(journal, "0039_d62_chat_write_mode");
      await isolateSchemas(target, PREFIX);
      isolated = true;
      await stageThrough(directory, journal, first);
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
      await seedWorkModeShape(target);
      await rm(directory, { recursive: true, force: true });
      await stageThrough(directory, journal, journal.entries.length);
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });

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
      await control("switch", { kind: "write_mode", mode: "direct" });
      await control("compact", { kind: "compact" });
      await expect(control("bad-mode", { kind: "write_mode", mode: "live" })).rejects.toMatchObject(
        { code: "23514" },
      );
      await expect(
        target`UPDATE threads SET ai_write_mode = 'live' WHERE id = ${id(10)}`,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      if (isolated) await restoreSchemas(target, PREFIX);
      await target.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
