/**
 * PostgreSQL coverage for R2: the project list and the live state read the
 * running turn from the live run lease, and agree on liveness.
 */

import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-0000000009a1" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-0000000009a2" as ProjectId;
const THREAD_ID = "00000000-0000-4000-8000-0000000009a3" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-0000000009a4" as TurnId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread liveness (postgres)", () => {});
} else {
  describe("thread liveness (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRunAuthority } = await import("../../../runtime/index.js");
    const { createThreadRuntimeService } = await import("../../runtime-service.js");
    const { createDrizzleThreadRepository } = await import("./thread-repository.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 6 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "thread-liveness"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Thread Liveness",
        slug: "thread-liveness",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Chat",
      });
      await db.insert(schema.turns).values({
        id: TURN_ID,
        threadId: THREAD_ID,
        role: "assistant",
        status: "streaming",
      });
    });

    afterAll(async () => {
      await db.close();
    });

    it("reads the running turn from the lease in both the list and live state", async () => {
      const authority = createDrizzleRunAuthority(db);
      const repo = createDrizzleThreadRepository(db);
      const runtime = createThreadRuntimeService({ db, statusReader: authority });

      const lease = await authority.acquire(THREAD_ID, "run-1");
      if (!lease) throw new Error("expected the lease to be acquired");
      await authority.bindTurn(lease, TURN_ID);

      const listed = (await repo.listByProject(PROJECT_ID)).find((row) => row.id === THREAD_ID);
      const live = await runtime.liveState(THREAD_ID, USER_ID);
      expect(listed?.runningTurnId).toBe(TURN_ID);
      expect(live.runningTurnId).toBe(TURN_ID);
      expect(live.status).toEqual({ kind: "awake", phase: "generating", cancelRequested: false });

      await authority.release(lease);

      const afterRelease = (await repo.listByProject(PROJECT_ID)).find(
        (row) => row.id === THREAD_ID,
      );
      const liveAfterRelease = await runtime.liveState(THREAD_ID, USER_ID);
      expect(afterRelease?.runningTurnId).toBeNull();
      expect(liveAfterRelease.runningTurnId).toBeNull();
      expect(liveAfterRelease.status).toEqual({ kind: "asleep" });
    });
  });
}
