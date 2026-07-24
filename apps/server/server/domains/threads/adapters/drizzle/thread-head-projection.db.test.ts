/** Postgres regression coverage for canonical thread-head lifecycle projection. */

import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadEventHub } from "../../thread-event-hub.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000401";
const PROJECT_ID = "00000000-0000-4000-8000-000000000402";
const WORK_ID = "00000000-0000-4000-8000-000000000403";
const THREAD_ID = "00000000-0000-4000-8000-000000000404";
const USER_TURN_ID = "00000000-0000-4000-8000-000000000405";
const ASSISTANT_TURN_ID = "00000000-0000-4000-8000-000000000406";
const INACTIVE_USER_TURN_ID = "00000000-0000-4000-8000-000000000407";
const INTERLEAVED_USER_TURN_ID = "00000000-0000-4000-8000-000000000408";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread head projection (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("thread head projection (postgres)", async () => {
    const { eq } = await import("drizzle-orm");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase } = await import(
      "../../../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { buildThreadSnapshot } = await import("../../thread-snapshot.js");
    const { createDrizzleRepositories } = await import("./repositories.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 1,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;
    let repos = createDrizzleRepositories(db);
    const emptyHub: ThreadEventHub = {
      publishPersistedEvent: () => {},
      appendEvent: async () => {
        throw new Error("appendEvent is not used by this projection test");
      },
      catchup: async () => [],
      subscribe: () => () => {},
      catchupAndSubscribe: async () => ({
        catchup: [],
        hitReplayLimit: false,
        unsubscribe: () => {},
      }),
      hasThreadState: () => false,
      headSeq: async () => 0n,
      readModelProjectionWatermark: async () => 0n,
      journalSeqForEventSeq: (seq) => seq,
    };

    beforeEach(async () => {
      db = database.current;
      repos = createDrizzleRepositories(db);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "thread-head"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Thread Head Project",
        slug: "thread-head-project",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread Head Work",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Tied Turns",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });

      const createdAt = "2026-07-10T00:00:00.000Z";
      await repos.turns.create({
        id: USER_TURN_ID,
        threadId: THREAD_ID,
        role: "user",
        status: "complete",
        createdAt,
      });
      await repos.turns.create({
        id: ASSISTANT_TURN_ID,
        threadId: THREAD_ID,
        prevTurnId: USER_TURN_ID,
        role: "assistant",
        status: "complete",
        createdAt,
      });
      await repos.turns.create({
        id: INACTIVE_USER_TURN_ID,
        threadId: THREAD_ID,
        prevTurnId: USER_TURN_ID,
        role: "user",
        status: "complete",
        createdAt,
      });
      await db
        .update(schema.threads)
        .set({ activeLeafTurnId: ASSISTANT_TURN_ID })
        .where(eq(schema.threads.id, THREAD_ID));
    });

    it("converges project/work lists and snapshot when user and assistant timestamps tie", async () => {
      const [projectThreads, workThreads, snapshot] = await Promise.all([
        repos.threads.listByProject(PROJECT_ID),
        repos.threads.listByWork(PROJECT_ID, WORK_ID),
        buildThreadSnapshot(repos, emptyHub, { getRunningTurnId: () => null }, THREAD_ID, USER_ID),
      ]);

      expect(projectThreads).toHaveLength(1);
      expect(workThreads).toHaveLength(1);
      expect(projectThreads[0]?.attention).toBe(snapshot.attention);
      expect(workThreads[0]?.attention).toBe(snapshot.attention);
      expect(snapshot.attention).toBe("unread");
    });

    it("clears unread after the writer opens the thread", async () => {
      await repos.threads.markOpened(THREAD_ID, USER_ID);
      const [row] = await repos.threads.listByProject(PROJECT_ID);
      const snapshot = await buildThreadSnapshot(
        repos,
        emptyHub,
        { getRunningTurnId: () => null },
        THREAD_ID,
        USER_ID,
      );
      expect(row?.attention).toBe("none");
      expect(snapshot.attention).toBe("none");
    });

    it("never advertises a sequence newer than its durable turn payload", async () => {
      let committed = false;
      const interleavingHub = {
        ...emptyHub,
        headSeq: async () => {
          await repos.turns.create({
            id: INTERLEAVED_USER_TURN_ID,
            threadId: THREAD_ID,
            prevTurnId: ASSISTANT_TURN_ID,
            role: "user",
            status: "complete",
            createdAt: "2026-07-10T00:00:01.000Z",
          });
          committed = true;
          return 7n;
        },
      } satisfies ThreadEventHub;

      const snapshot = await buildThreadSnapshot(
        repos,
        interleavingHub,
        { getRunningTurnId: () => null },
        THREAD_ID,
        USER_ID,
      );

      expect(committed).toBe(true);
      expect(snapshot.nextSeq).toBe("8");
      expect(snapshot.turns.map((turn) => turn.id)).toContain(INTERLEAVED_USER_TURN_ID);
    });
  });
}
