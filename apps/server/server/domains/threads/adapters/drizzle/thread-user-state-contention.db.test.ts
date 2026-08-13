/** PostgreSQL row-contention coverage for opposing thread read-state writers. */

import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-4000-8000-000000000551";
const PROJECT_ID = "00000000-0000-4000-8000-000000000552";
const THREAD_ID = "00000000-0000-4000-8000-000000000553";
const ADVISORY_KEY = 748_210_553;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread user state contention (postgres)", () => {});
} else {
  describe("thread user state contention (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositories } = await import("./repositories.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const writers = createDb(DATABASE_URL, { max: 2 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const firstWriter = createDrizzleRepositories(writers);
    const secondWriter = createDrizzleRepositories(writers);

    async function dropBarrier(): Promise<void> {
      await control.unsafe(`
        DROP TRIGGER IF EXISTS test_block_manual_unread ON thread_user_state;
        DROP FUNCTION IF EXISTS test_block_manual_unread();
      `);
    }

    beforeEach(async () => {
      await dropBarrier();
      await truncateDrizzleTables(writers, [schema.users]);
      await writers
        .insert(schema.users)
        .values(conformanceUserValues(USER_ID, "thread-user-state-contention"));
      await writers.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Thread user state contention",
        slug: "thread-user-state-contention",
      });
      await writers.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Contended state",
        kind: "primary",
        status: "idle",
      });
    });

    afterAll(async () => {
      await dropBarrier();
      await control.end();
      await writers.close();
    });

    async function waitForStateRowContention(): Promise<number> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await control<{ pid: number }[]>`
          SELECT pid
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event = 'transactionid'
            AND cardinality(pg_blocking_pids(pid)) > 0
            AND query LIKE '%INSERT INTO thread_user_state%'
          LIMIT 1
        `;
        if (row) return row.pid;
        await delay(10);
      }
      throw new Error("Timed out waiting for thread_user_state row contention");
    }

    async function waitForUnreadBarrier(): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await control<{ pid: number }[]>`
          SELECT pid
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event = 'advisory'
            AND query LIKE '%INSERT INTO thread_user_state%'
          LIMIT 1
        `;
        if (row) return;
        await delay(10);
      }
      throw new Error("Timed out waiting for mark-unread barrier");
    }

    it("serializes opposing unread then read commands on the same writer state row", async () => {
      const initial = await firstWriter.threadUserState.update({
        threadId: THREAD_ID,
        userId: USER_ID,
        isUnread: false,
      });
      if (!initial.lastOpenedAt) throw new Error("initial read command did not set last_opened_at");

      await control.unsafe(`
        CREATE FUNCTION test_block_manual_unread() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_manual_unread
        AFTER UPDATE ON thread_user_state
        FOR EACH ROW WHEN (NEW.manually_unread)
        EXECUTE FUNCTION test_block_manual_unread();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let barrierHeld = true;

      try {
        const markUnread = firstWriter.threadUserState.update({
          threadId: THREAD_ID,
          userId: USER_ID,
          isUnread: true,
        });
        await waitForUnreadBarrier();

        const markRead = secondWriter.threadUserState.update({
          threadId: THREAD_ID,
          userId: USER_ID,
          isUnread: false,
        });
        await expect(waitForStateRowContention()).resolves.toBeGreaterThan(0);

        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        barrierHeld = false;
        const [unreadResult, readResult] = await Promise.all([markUnread, markRead]);
        const finalState = await firstWriter.threadUserState.get(THREAD_ID, USER_ID);

        expect(unreadResult).toMatchObject({
          manuallyUnread: true,
          lastOpenedAt: initial.lastOpenedAt,
        });
        expect(readResult.manuallyUnread).toBe(false);
        expect(finalState).toEqual({
          isFavorite: false,
          manuallyUnread: false,
          lastOpenedAt: readResult.lastOpenedAt,
        });
        expect(new Date(finalState.lastOpenedAt ?? 0).getTime()).toBeGreaterThanOrEqual(
          new Date(initial.lastOpenedAt).getTime(),
        );
      } finally {
        if (barrierHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await dropBarrier();
      }
    });
  });
}
