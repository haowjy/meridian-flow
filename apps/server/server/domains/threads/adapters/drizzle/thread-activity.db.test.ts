/** PostgreSQL coverage for direct-child activity and fork history through trashed sources. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadThreadConversationContext } from "../../index.js";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../../test-support/thread-work-postgres-harness.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread activity and fork history (postgres)", () => {});
} else {
  describe("thread activity and fork history (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");

    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);
    const ids = THREAD_WORK_RACE;

    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
    });

    afterAll(() => db.close());

    it("lists only direct live children and excludes trashed rows", async () => {
      const root = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Activity root",
      });
      const childA = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        parentThreadId: root.id,
        rootThreadId: root.id,
        spawnDepth: 1,
        title: "Child A",
      });
      const childB = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        parentThreadId: root.id,
        rootThreadId: root.id,
        spawnDepth: 1,
        title: "Child B",
      });
      const grandchild = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        parentThreadId: childA.id,
        rootThreadId: root.id,
        spawnDepth: 2,
        title: "Grandchild",
      });
      const sourceTurn = await repos.turns.create({
        threadId: childA.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const derivedPrimary = await repos.threads.createDerivedPrimary({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        source: childA,
        originType: "fork",
        originTurnId: sourceTurn.id,
      });

      expect((await repos.threads.listChildren(root.id)).map((child) => child.id)).toEqual([
        childA.id,
        childB.id,
      ]);
      expect(derivedPrimary.kind).toBe("primary");
      expect((await repos.threads.listChildren(childA.id)).map((child) => child.id)).toEqual([
        grandchild.id,
      ]);
      await repos.threads.setTrashState(childB.id, "deleted");
      expect((await repos.threads.listChildren(root.id)).map((child) => child.id)).toEqual([
        childA.id,
      ]);
    });

    it("serves a fork's inherited turns after its source is trashed", async () => {
      const source = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Trashed source",
      });
      const sourceTurn = await repos.turns.create({
        threadId: source.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const fork = await repos.threads.createDerivedPrimary({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        source,
        originType: "fork",
        originTurnId: sourceTurn.id,
        title: "Fork",
      });
      await repos.threads.setTrashState(source.id, "deleted");

      expect(await repos.threads.findById(source.id)).toBeNull();
      const context = await loadThreadConversationContext(
        { threads: repos.threads, turns: repos.turns, blocks: repos.blocks },
        fork,
      );

      expect(context.turns.map((turn) => turn.id)).toEqual([sourceTurn.id]);
    });
  });
}
