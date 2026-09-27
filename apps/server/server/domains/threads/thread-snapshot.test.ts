/**
 * Subagent snapshots resolve parent by id, not from a primary list.
 */
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
      inputTokens: 50,
      cacheReadTokens: 20,
      outputTokens: 5,
    });
    expect((await build()).threadUsage).toMatchObject({ inputTokens: 500, cacheResets: 1 });
  });

  it("keeps zero-input totals at zero for the client to hide", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      title: "Empty",
    });
    const snapshot = await buildThreadSnapshot(
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
    expect(snapshot.threadUsage).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheReportedInputTokens: 0,
      cacheReportedCalls: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      cacheResets: 0,
    });
  });

  it("loads the complete spawn chain root-first by id", async () => {
    const repos = createInMemoryRepositories();
    const parent = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      title: "Muse chat",
    });
    const parentTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const child = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: parent.id as ThreadId,
      rootThreadId: parent.id as ThreadId,
      originTurnId: parentTurn.id,
      spawnDepth: 1,
      title: "Critic",
    });
    const childTurn = await repos.turns.create({
      threadId: child.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const nested = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: child.id as ThreadId,
      rootThreadId: parent.id as ThreadId,
      originTurnId: childTurn.id,
      spawnDepth: 2,
      title: "Helper",
    });

    const snapshot = await buildThreadSnapshot(
      repos,
      stubHub(),
      {
        read: async () => ({ kind: "asleep" as const }),
        readRunningTurnId: async () => null,
        readMany: async () => new Map(),
        readPending: async () => ({ items: [] }),
      },
      nested.id as ThreadId,
    );

    expect(snapshot.ancestors).toEqual([
      { id: parent.id, title: "Muse chat", agentName: parent.agentName ?? null },
      { id: child.id, title: "Critic", agentName: child.agentName ?? null },
    ]);
  });

  it("includes model-response TTFT in the assistant turn snapshot", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      title: "Muse chat",
    });
    const turn = await repos.turns.create({
      threadId: thread.id as ThreadId,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await repos.modelResponses.create({
      id: "response-1",
      turnId: turn.id,
      sequence: 0,
      provider: "test-provider",
      model: "test-model",
      priceSource: "unknown",
      latencyMs: 100,
      timeToFirstTokenMs: 27,
      generationMs: 73,
    });

    const snapshot = await buildThreadSnapshot(
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

    expect(snapshot.turns[0]?.responses[0]).toMatchObject({
      latencyMs: 100,
      timeToFirstTokenMs: 27,
      generationMs: 73,
    });
  });

  it("keeps a parked assistant question action-required behind a writer turn", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      title: "Muse chat",
    });
    const parkedAssistant = await repos.turns.create({
      threadId: thread.id as ThreadId,
      role: "assistant",
      origin: "assistant",
      status: "waiting_interrupt",
    });
    const writerTurn = await repos.turns.create({
      threadId: thread.id as ThreadId,
      prevTurnId: parkedAssistant.id,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    await repos.blocks.create({
      turnId: writerTurn.id,
      blockType: "text",
      sequence: 0,
      textContent: "one more detail",
    });

    const snapshot = await buildThreadSnapshot(
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

    expect(snapshot.actionRequired).toBe(true);
  });

  it("snapshots direct children without grandchildren or lineage-only fields", async () => {
    const repos = createInMemoryRepositories();
    const parent = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const parentTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const child = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: parent.id as ThreadId,
      rootThreadId: parent.id as ThreadId,
      originTurnId: parentTurn.id,
      spawnDepth: 1,
      title: "Critic",
    });
    const childTurn = await repos.turns.create({
      threadId: child.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: child.id as ThreadId,
      rootThreadId: parent.id as ThreadId,
      originTurnId: childTurn.id,
      spawnDepth: 2,
      title: "Helper",
    });

    const snapshot = await buildThreadSnapshot(
      repos,
      stubHub(),
      {
        read: async () => ({ kind: "asleep" as const }),
        readRunningTurnId: async () => null,
        readMany: async () => new Map(),
        readPending: async () => ({ items: [] }),
      },
      parent.id as ThreadId,
    );

    expect(snapshot.liveState.activity.children).toEqual([
      {
        threadId: child.id,
        parentThreadId: parent.id,
        ref: child.ref,
        title: "Critic",
        agentName: child.agentName,
        spawnStatus: "running",
        status: { kind: "asleep" },
        originTurnId: parentTurn.id,
        deliveryMode: null,
        runStartedAt: null,
        runEndedAt: null,
        currentTool: null,
      },
    ]);
  });
});
