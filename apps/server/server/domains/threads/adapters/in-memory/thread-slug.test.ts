/** Repository integration for first-title slug assignment and stable handles. */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./repositories.js";

describe("in-memory thread slug projection", () => {
  it("assigns collision counters once and leaves untitled threads null", async () => {
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
    expect(untitled.slug).toBeNull();
    await expect(repos.threads.updateStatus(first.id, "active")).resolves.toMatchObject({
      slug: "chapter-plan",
    });
  });
});
