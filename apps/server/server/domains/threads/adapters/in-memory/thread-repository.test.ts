/** In-memory ThreadRepository contracts for direct-child selection. */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./repositories.js";

describe("in-memory ThreadRepository.listChildren", () => {
  it("excludes derived primary threads even when they share a subagent parent", async () => {
    const repos = createInMemoryRepositories();
    const root = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const originTurn = await repos.turns.create({
      threadId: root.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const subagent = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: root.id,
      rootThreadId: root.id,
      originTurnId: originTurn.id,
      spawnDepth: 1,
    });
    const sourceTurn = await repos.turns.create({
      threadId: subagent.id,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    const derivedInput = {
      id: crypto.randomUUID() as never,
      userId: "user-1",
      projectId: "project-1",
      workId: null,
      source: subagent,
      originType: "fork",
      originTurnId: sourceTurn.id,
    } as const;
    const created = await repos.threads.createDerivedPrimary(derivedInput);
    const derivedPrimary = created.thread;
    const replay = await repos.threads.createDerivedPrimary(derivedInput);

    expect(created.created).toBe(true);
    expect(replay).toMatchObject({ created: false, thread: { id: derivedPrimary.id } });
    expect(derivedPrimary.kind).toBe("primary");
    expect(derivedPrimary.parentThreadId).toBe(root.id);
    expect(await repos.threads.listChildren(root.id)).toMatchObject([{ id: subagent.id }]);
  });
});
