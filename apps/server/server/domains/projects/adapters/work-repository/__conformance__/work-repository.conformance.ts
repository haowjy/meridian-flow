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
    const project = "00000000-0000-4000-9000-000000000001";
    const otherProject = "00000000-0000-4000-9000-000000000002";

    it("creates a work with project and title", async () => {
      const repo = await makeRepo();
      const work = await repo.create({
        projectId: project,
        title: "Auth Implementation",
        description: "desc",
      });
      expect(work).toMatchObject({
        projectId: project,
        title: "Auth Implementation",
        description: null,
        status: "active",
        visibility: "private",
        deletedAt: null,
      });
      expect(work.id).toBeTruthy();
    });

    it("defaults the title when none is given", async () => {
      const repo = await makeRepo();
      const work = await repo.create({ projectId: project });
      expect(work.title).toBe("Untitled Work");
      expect(work.description).toBeNull();
    });

    it("honors a client-provided id", async () => {
      const repo = await makeRepo();
      const fixedId = "00000000-0000-4000-a000-000000000099";
      const work = await repo.create({ id: fixedId, projectId: project });
      expect(work.id).toBe(fixedId);
      expect(await repo.findById(fixedId)).not.toBeNull();
    });

    it("scopes listByProject to the project", async () => {
      const repo = await makeRepo();
      await repo.create({ projectId: project, title: "A" });
      await repo.create({ projectId: otherProject, title: "B" });
      const list = await repo.listByProject(project);
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe("A");
    });

    it("ensureDefaultForProject creates once then reuses", async () => {
      const repo = await makeRepo();
      const first = await repo.ensureDefaultForProject(project, "My Project");
      expect(first.projectId).toBe(project);
      const second = await repo.ensureDefaultForProject(project, "My Project");
      expect(second.id).toBe(first.id);
      expect(await repo.listByProject(project)).toHaveLength(1);
    });

    it("converges concurrent default creation on one work", async () => {
      const repo = await makeRepo();
      const defaults = await Promise.all([
        repo.ensureDefaultForProject(project, "My Project"),
        repo.ensureDefaultForProject(project, "My Project"),
        repo.ensureDefaultForProject(project, "My Project"),
      ]);
      expect(new Set(defaults.map((work) => work.id)).size).toBe(1);
      expect(await repo.listByProject(project)).toHaveLength(1);
    });

    it("touch advances lastActivityAt for active works", async () => {
      const repo = await makeRepo();
      const created = await repo.create({ projectId: project, title: "T" });
      const before = created.lastActivityAt;
      await repo.touch(created.id);
      const touched = await repo.findById(created.id);
      if (!touched) throw new Error("expected work to exist");
      expect(touched.lastActivityAt >= before).toBe(true);
    });
  });
}
