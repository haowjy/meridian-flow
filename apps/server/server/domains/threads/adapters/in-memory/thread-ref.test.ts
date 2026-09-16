/** Repository integration for sequential `cN` refs and deleted reservations. */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./repositories.js";

describe("in-memory thread ref assignment", () => {
  it.each([
    "create",
    "createSubagent",
    "createDerivedPrimary",
  ] as const)("rejects duplicate identity through %s without reassigning ref", async (operation) => {
    const repos = createInMemoryRepositories();
    const input = {
      id: "duplicate-id",
      userId: "user-1",
      projectId: "project-1",
      workId: null,
      parentThreadId: "parent",
      rootThreadId: "parent",
      spawnDepth: 1,
      composedSystemPrompt: "",
      bakedSkillSlugs: [],
      originType: "fork" as const,
    };
    const first =
      operation === "create"
        ? await repos.threads.create({
            id: input.id,
            userId: input.userId,
            projectId: input.projectId,
          })
        : await repos.threads[operation](input);
    const retry =
      operation === "create"
        ? repos.threads.create({ id: input.id, userId: input.userId, projectId: input.projectId })
        : repos.threads[operation](input);
    await expect(retry).rejects.toThrow();
    expect(await repos.threads.findById(first.id)).toEqual(first);
  });

  it("assigns c1 then c2 for two primary creates in one project", async () => {
    const repos = createInMemoryRepositories();
    const first = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      title: "Chapter Plan",
    });
    const second = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      title: "Chapter Plan",
    });
    expect(first.ref).toBe("c1");
    expect(second.ref).toBe("c2");
    expect(await repos.threads.findLiveByProjectRef("project-1", "c1")).toMatchObject({
      id: first.id,
    });
    expect(await repos.threads.findLiveByProjectRef("project-2", "c1")).toBeNull();
    await expect(repos.threads.updateStatus(first.id, "active")).resolves.toMatchObject({
      ref: "c1",
    });
  });

  it("leaves subagent ref null and does not increment the project counter", async () => {
    const repos = createInMemoryRepositories();
    const primary = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const subagent = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: primary.id,
      rootThreadId: primary.id,
      spawnDepth: 1,
    });
    const next = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    expect(primary.ref).toBe("c1");
    expect(subagent.ref).toBeNull();
    expect(next.ref).toBe("c2");
  });

  it("reserves a deleted handle and isolates exact project lookup", async () => {
    const repos = createInMemoryRepositories();
    const first = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    expect(await repos.threads.findLiveByProjectRef("project-1", "c1")).toMatchObject({
      id: first.id,
    });
    await repos.threads.setTrashState(first.id, "deleted");
    expect(await repos.threads.findLiveByProjectRef("project-1", "c1")).toBeNull();
    expect((await repos.threads.create({ userId: "user-1", projectId: "project-1" })).ref).toBe(
      "c2",
    );
    await repos.threads.setTrashState(first.id, "visible");
    expect(await repos.threads.findLiveByProjectRef("project-1", "c1")).toMatchObject({
      id: first.id,
    });
  });
});
