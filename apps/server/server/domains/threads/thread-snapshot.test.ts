/** Thread snapshots aggregate every billed call without borrowing child usage. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./adapters/in-memory/repositories.js";
import type { ThreadEventHub } from "./thread-event-hub.js";
import { buildThreadSnapshot } from "./thread-snapshot.js";

function stubHub(): ThreadEventHub {
  return {
    async headSeq() {
      return 0n;
    },
    async readModelProjectionWatermark() {
      return 0n;
    },
  } as unknown as ThreadEventHub;
}

describe("buildThreadSnapshot ancestors", () => {
  it("aggregates all billed calls and reflects the next persisted response in a fresh snapshot", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      title: "Muse chat",
    });
    const firstTurn = await repos.turns.create({
      threadId: thread.id as ThreadId,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await repos.modelResponses.create({
      id: "response-a",
      turnId: firstTurn.id,
      sequence: 0,
      provider: "test",
      model: "m",
      priceSource: "unknown",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
      inputTokens: 100,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      outputTokens: 12,
    });
    const build = () =>
      buildThreadSnapshot(
        repos,
        stubHub(),
        {
          read: async () => ({ kind: "asleep" as const }),
          readRunningTurnId: async () => null,
          readMany: async () => new Map(),
          readPending: async () => ({ items: [] }),
        },
        thread.id as ThreadId,
      );
    expect((await build()).threadUsage).toEqual({
      inputTokens: 100,
      cacheReadTokens: 40,
      cacheReportedInputTokens: 100,
      cacheReportedCalls: 1,
      cacheWriteTokens: 10,
      outputTokens: 12,
      cacheResets: 0,
    });

    const branchedTurn = await repos.turns.create({
      threadId: thread.id as ThreadId,
      prevTurnId: firstTurn.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await repos.modelResponses.create({
      id: "response-b",
      turnId: branchedTurn.id,
      sequence: 0,
      provider: "test",
      model: "m",
      priceSource: "unknown",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
      inputTokens: 300,
      cacheReadTokens: 40,
      outputTokens: 20,
      cacheReset: true,
    });
    await repos.modelResponses.create({
      id: "response-c",
      turnId: branchedTurn.id,
      sequence: 1,
      provider: "provider-without-cache-reporting",
      model: "m",
      priceSource: "unknown",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
      inputTokens: 100,
      outputTokens: 4,
      cacheReadTokens: null,
    });
    expect((await build()).threadUsage).toEqual({
      inputTokens: 500,
      cacheReadTokens: 80,
      cacheReportedInputTokens: 400,
      cacheReportedCalls: 2,
      cacheWriteTokens: 10,
      outputTokens: 36,
      cacheResets: 1,
    });

    const child = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: thread.id as ThreadId,
      rootThreadId: thread.id as ThreadId,
      spawnDepth: 1,
      title: "Child",
      originTurnId: branchedTurn.id,
    });
    const childTurn = await repos.turns.create({
      threadId: child.id as ThreadId,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await repos.modelResponses.create({
      id: "child-response",
      turnId: childTurn.id,
      sequence: 0,
      provider: "test",
      model: "m",
      priceSource: "unknown",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
      inputTokens: 50,
      cacheReadTokens: 20,
      outputTokens: 5,
    });
    expect((await build()).threadUsage).toMatchObject({ inputTokens: 500, cacheResets: 1 });
  });
});
