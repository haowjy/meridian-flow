/** Repository integration for stable creation-time handles and deleted reservations. */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./repositories.js";

describe("in-memory thread slug projection", () => {
  it.each([
    "create",
    "createSubagent",
    "createDerivedPrimary",
  ] as const)("rejects duplicate identity through %s without re-slugging", async (operation) => {
    const repos = createInMemoryRepositories();
    const input = {
      id: "duplicate-id",
      userId: "user-1",
      projectId: "project-1",
      workId: null,
      parentThreadId: "parent",
      rootThreadId: "parent",
      spawnDepth: 1,
      currentAgent: "writer",
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

  it("reserves a deleted handle and isolates exact project lookup", async () => {
    const repos = createInMemoryRepositories();
    const first = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    expect(await repos.threads.findLiveByProjectSlug("project-1", "chat")).toMatchObject({
      id: first.id,
    });
    expect(await repos.threads.findLiveByProjectSlug("project-2", "chat")).toBeNull();
    await repos.threads.setTrashState(first.id, "deleted");
    expect(await repos.threads.findLiveByProjectSlug("project-1", "chat")).toBeNull();
    expect((await repos.threads.create({ userId: "user-1", projectId: "project-1" })).slug).toBe(
      "chat-2",
    );
    await repos.threads.setTrashState(first.id, "visible");
    expect(await repos.threads.findLiveByProjectSlug("project-1", "chat")).toMatchObject({
      id: first.id,
    });
  });

  it("assigns collision counters once and gives untitled threads readable handles", async () => {
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
    const untitled = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
    });

    expect(first.slug).toBe("chapter-plan");
    expect(second.slug).toBe("chapter-plan-2");
    expect(untitled.slug).toBe("chat");
    await expect(repos.threads.updateStatus(first.id, "active")).resolves.toMatchObject({
      slug: "chapter-plan",
    });
  });
});
