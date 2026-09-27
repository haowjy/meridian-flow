/** In-memory model-response repository behavior shared with runtime consumers. */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./repositories.js";

describe("in-memory model response repository", () => {
  it("returns only the latest response by turn position, then sequence", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const firstTurn = await repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const lastTurn = await repos.turns.create({
      threadId: thread.id,
      prevTurnId: firstTurn.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const base = {
      provider: "test-provider",
      model: "test-model",
      priceSource: "unknown" as const,
    };
    await repos.modelResponses.create({
      ...base,
      turnId: firstTurn.id,
      sequence: 4,
    });
    await repos.modelResponses.create({
      ...base,
      turnId: lastTurn.id,
      sequence: 0,
    });
    const newest = await repos.modelResponses.create({
      ...base,
      turnId: lastTurn.id,
      sequence: 2,
      predictedCacheState: "warm",
      predictedCacheReason: "reusable_prefix",
    });

    await expect(repos.modelResponses.findLatestByThread(thread.id)).resolves.toEqual({
      turnId: lastTurn.id,
      sequence: 2,
      model: "test-model",
      createdAt: newest.row.createdAt,
    });
    await expect(repos.modelResponses.findById(newest.row.id)).resolves.toMatchObject({
      predictedCacheState: "warm",
      predictedCacheReason: "reusable_prefix",
    });
  });
});
