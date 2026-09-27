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
      inputTokens: 200,
      requestStartedAt: "2026-09-27T12:00:00.000Z",
      predictedCacheState: "warm",
      predictedCacheReason: "reusable_prefix",
    });

    // A late projection on an older turn must not become the latest cache fact.
    await repos.modelResponses.create({
      ...base,
      turnId: firstTurn.id,
      sequence: 10,
      inputTokens: 999,
    });
    await expect(repos.modelResponses.cacheResetContext(thread.id)).resolves.toMatchObject({
      previousInputTokens: 200,
    });

    await expect(repos.modelResponses.findLatestByThread(thread.id)).resolves.toEqual({
      turnId: lastTurn.id,
      sequence: 2,
      model: "test-model",
      requestStartedAt: newest.row.requestStartedAt,
    });
    await expect(repos.modelResponses.findById(newest.row.id)).resolves.toMatchObject({
      predictedCacheState: "warm",
      predictedCacheReason: "reusable_prefix",
    });
  });
});
