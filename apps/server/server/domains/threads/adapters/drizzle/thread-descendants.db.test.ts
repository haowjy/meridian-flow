/**
 * PostgreSQL coverage for R3: `listDescendants` walks a thread's own subtree in
 * breadth-first order using `parent_thread_id`, independent of the shared root.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../../test-support/thread-work-postgres-harness.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread descendants (postgres)", () => {});
} else {
  describe("thread descendants (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");

    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);
    const ids = THREAD_WORK_RACE;

    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
    });

    afterAll(() => db.close());

    it("enumerates a multi-level subtree depth-first by lineage, not by root", async () => {
      const root = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Subtree root",
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
      const siblingRoot = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Sibling root",
      });
      const siblingChild = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        parentThreadId: siblingRoot.id,
        rootThreadId: siblingRoot.id,
        spawnDepth: 1,
        title: "Sibling child",
      });

      const descendants = await repos.threads.listDescendants(root.id);

      expect(descendants.map((node) => node.id)).toEqual([childA.id, childB.id, grandchild.id]);
      expect(descendants.map((node) => node.spawnDepth)).toEqual([1, 1, 2]);
      expect(descendants.map((node) => node.parentThreadId)).toEqual([root.id, root.id, childA.id]);
      expect(descendants.every((node) => node.rootThreadId === root.id)).toBe(true);
      expect(descendants.find((node) => node.id === childA.id)).toMatchObject({
        title: "Child A",
        spawnStatus: "running",
      });
      expect(descendants.find((node) => node.id === childA.id)?.ref).toMatch(/^p\d+$/);
      expect(descendants.map((node) => node.id)).not.toContain(siblingChild.id);
      expect(descendants.map((node) => node.id)).not.toContain(root.id);
    });

    it("excludes soft-deleted descendants", async () => {
      const root = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Subtree root",
      });
      const child = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        parentThreadId: root.id,
        rootThreadId: root.id,
        spawnDepth: 1,
        title: "Trashed child",
      });
      await repos.threads.setTrashState(child.id, "deleted");

      expect(await repos.threads.listDescendants(root.id)).toEqual([]);
    });
  });
}
