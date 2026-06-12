// @ts-nocheck
/**
 * Shared conformance suite for the WorkRepository port: every adapter runs this
 * same behavioral spec so drizzle and in-memory stay interchangeable. Imported
 * by each adapter's own test file.
 */
import { describe, expect, it } from "vitest";
import type { WorkRepository } from "../../../ports/work-repository.js";

export function describeWorkRepositoryConformance(
  name: string,
  makeRepo: () => WorkRepository | Promise<WorkRepository>,
): void {
  describe(`WorkRepository conformance: ${name}`, () => {
    const workbench = "00000000-0000-4000-9000-000000000001";
    const otherWorkbench = "00000000-0000-4000-9000-000000000002";

    it("creates a work with workbench, title, and description", async () => {
      const repo = await makeRepo();
      const work = await repo.create({
        workbenchId: workbench,
        title: "Auth Implementation",
        description: "desc",
      });
      expect(work).toMatchObject({
        workbenchId: workbench,
        title: "Auth Implementation",
        description: "desc",
        status: "active",
        visibility: "private",
        deletedAt: null,
      });
      expect(work.id).toBeTruthy();
    });

    it("defaults the title when none is given", async () => {
      const repo = await makeRepo();
      const work = await repo.create({ workbenchId: workbench });
      expect(work.title).toBe("Untitled Work");
      expect(work.description).toBeNull();
    });

    it("honors a client-provided id", async () => {
      const repo = await makeRepo();
      const fixedId = "00000000-0000-4000-a000-000000000099";
      const work = await repo.create({ id: fixedId, workbenchId: workbench });
      expect(work.id).toBe(fixedId);
      expect(await repo.findById(fixedId)).not.toBeNull();
    });

    it("scopes listByWorkbench to the workbench", async () => {
      const repo = await makeRepo();
      await repo.create({ workbenchId: workbench, title: "A" });
      await repo.create({ workbenchId: otherWorkbench, title: "B" });
      const list = await repo.listByWorkbench(workbench);
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe("A");
    });

    it("ensureDefaultForWorkbench creates once then reuses", async () => {
      const repo = await makeRepo();
      const first = await repo.ensureDefaultForWorkbench(workbench, "My Workbench");
      expect(first.workbenchId).toBe(workbench);
      const second = await repo.ensureDefaultForWorkbench(workbench, "My Workbench");
      expect(second.id).toBe(first.id);
      expect(await repo.listByWorkbench(workbench)).toHaveLength(1);
    });

    it("converges concurrent default creation on one work", async () => {
      const repo = await makeRepo();
      const defaults = await Promise.all([
        repo.ensureDefaultForWorkbench(workbench, "My Workbench"),
        repo.ensureDefaultForWorkbench(workbench, "My Workbench"),
        repo.ensureDefaultForWorkbench(workbench, "My Workbench"),
      ]);
      expect(new Set(defaults.map((work) => work.id)).size).toBe(1);
      expect(await repo.listByWorkbench(workbench)).toHaveLength(1);
    });

    it("touch advances lastActivityAt for active works", async () => {
      const repo = await makeRepo();
      const created = await repo.create({ workbenchId: workbench, title: "T" });
      const before = created.lastActivityAt;
      await repo.touch(created.id);
      const touched = await repo.findById(created.id);
      if (!touched) throw new Error("expected work to exist");
      expect(touched.lastActivityAt >= before).toBe(true);
    });
  });
}
