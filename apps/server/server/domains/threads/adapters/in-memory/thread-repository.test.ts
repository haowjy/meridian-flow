/** In-memory ThreadRepository contracts for direct-child selection. */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./repositories.js";

describe("in-memory ThreadRepository.listChildren", () => {
  it("excludes derived primary threads even when they share a subagent parent", async () => {
    const repos = createInMemoryRepositories();
    const root = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const subagent = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: root.id,
      rootThreadId: root.id,
      spawnDepth: 1,
    });
    const sourceTurn = await repos.turns.create({
      threadId: subagent.id,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    const derivedPrimary = await repos.threads.createDerivedPrimary({
      userId: "user-1",
      projectId: "project-1",
      workId: null,
      source: subagent,
      originType: "fork",
      originTurnId: sourceTurn.id,
    });

    expect(derivedPrimary.kind).toBe("primary");
    expect(derivedPrimary.parentThreadId).toBe(root.id);
    expect(await repos.threads.listChildren(root.id)).toMatchObject([{ id: subagent.id }]);
  });
});
