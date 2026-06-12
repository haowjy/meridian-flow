// @ts-nocheck
/**
 * Shared conformance suite for the WorkbenchRepository port: every adapter runs
 * this same behavioral spec so drizzle and in-memory stay interchangeable.
 * Imported by each adapter's own test file.
 */
import { describe, expect, it } from "vitest";
import type { WorkbenchRepository } from "../../../ports/workbench-repository.js";

export const WORKBENCH_REPOSITORY_CONFORMANCE_USER_1 = "00000000-0000-4000-9000-000000000301";
export const WORKBENCH_REPOSITORY_CONFORMANCE_USER_2 = "00000000-0000-4000-9000-000000000302";

export function describeWorkbenchRepositoryConformance(
  name: string,
  makeRepo: () => WorkbenchRepository | Promise<WorkbenchRepository>,
): void {
  describe(`WorkbenchRepository conformance: ${name}`, () => {
    it("creates a workbench with owner, title, and description", async () => {
      const repo = await makeRepo();
      const workbench = await repo.create({
        userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
        title: "Sample Workbench",
        description: "desc",
      });
      expect(workbench).toMatchObject({
        userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
        title: "Sample Workbench",
        description: "desc",
        deletedAt: null,
      });
      expect(workbench.id).toBeTruthy();
    });

    it("defaults the title when none is given", async () => {
      const repo = await makeRepo();
      const workbench = await repo.create({ userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1 });
      expect(workbench.title).toBe("Untitled Workbench");
      expect(workbench.description).toBeNull();
    });

    it("honors a client-provided id", async () => {
      const repo = await makeRepo();
      const fixedId = "00000000-0000-4000-a000-000000000001";
      const workbench = await repo.create({
        id: fixedId,
        userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
      });
      expect(workbench.id).toBe(fixedId);
      expect(await repo.findById(fixedId)).not.toBeNull();
    });

    it("updates title and description", async () => {
      const repo = await makeRepo();
      const created = await repo.create({
        userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
        title: "Old",
      });
      const updated = await repo.update(created.id, { title: "New", description: "d2" });
      expect(updated.title).toBe("New");
      expect(updated.description).toBe("d2");
    });

    it("throws when updating a missing workbench", async () => {
      const repo = await makeRepo();
      await expect(repo.update("missing", { title: "x" })).rejects.toThrow();
    });

    it("scopes listByUser to the owner", async () => {
      const repo = await makeRepo();
      await repo.create({ userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1, title: "A" });
      await repo.create({ userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_2, title: "B" });
      const mine = await repo.listByUser(WORKBENCH_REPOSITORY_CONFORMANCE_USER_1);
      expect(mine).toHaveLength(1);
      expect(mine[0].title).toBe("A");
    });

    it("runs the full soft-delete / restore lifecycle idempotently", async () => {
      const repo = await makeRepo();
      const created = await repo.create({
        userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
        title: "P",
      });

      const deleted = await repo.softDelete(created.id);
      expect(deleted.deletedAt).not.toBeNull();
      expect((await repo.findById(created.id))?.deletedAt).not.toBeNull();
      expect(await repo.listByUser(WORKBENCH_REPOSITORY_CONFORMANCE_USER_1)).toHaveLength(0);
      expect(
        await repo.listByUser(WORKBENCH_REPOSITORY_CONFORMANCE_USER_1, { includeDeleted: true }),
      ).toHaveLength(1);

      const deletedAgain = await repo.softDelete(created.id);
      expect(deletedAgain.deletedAt).toEqual(deleted.deletedAt);

      const restored = await repo.restore(created.id);
      expect(restored.deletedAt).toBeNull();
      expect(await repo.listByUser(WORKBENCH_REPOSITORY_CONFORMANCE_USER_1)).toHaveLength(1);

      const restoredAgain = await repo.restore(created.id);
      expect(restoredAgain.deletedAt).toBeNull();
    });

    it("searches active workbenches by title and description", async () => {
      const repo = await makeRepo();
      await repo.create({
        userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
        title: "Alpha Protocol",
        description: "notes",
      });
      await repo.create({
        userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
        title: "Beta",
        description: "other",
      });
      await repo.create({
        userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_2,
        title: "Alpha elsewhere",
      });

      const byTitle = await repo.search(WORKBENCH_REPOSITORY_CONFORMANCE_USER_1, "alpha");
      expect(byTitle.map((p) => p.title)).toEqual(["Alpha Protocol"]);

      const byDescription = await repo.search(WORKBENCH_REPOSITORY_CONFORMANCE_USER_1, "notes");
      expect(byDescription).toHaveLength(1);
      expect(byDescription[0].title).toBe("Alpha Protocol");
    });

    it("touch updates updatedAt for active workbenches and is a no-op when deleted", async () => {
      const repo = await makeRepo();
      const created = await repo.create({
        userId: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
        title: "Touch me",
      });

      const initial = await repo.findById(created.id);
      if (!initial) throw new Error("expected workbench to exist");
      const before = initial.updatedAt;

      await repo.touch(created.id);
      const touched = await repo.findById(created.id);
      if (!touched) throw new Error("expected workbench to exist");
      const afterTouch = touched.updatedAt;
      expect(afterTouch >= before).toBe(true);

      await repo.softDelete(created.id);
      const deleted = await repo.findById(created.id);
      if (!deleted) throw new Error("expected workbench to exist");
      const atDelete = deleted.updatedAt;
      await repo.touch(created.id);
      const afterDeletedTouch = await repo.findById(created.id);
      if (!afterDeletedTouch) throw new Error("expected workbench to exist");
      expect(afterDeletedTouch.updatedAt).toBe(atDelete);
    });
  });
}
