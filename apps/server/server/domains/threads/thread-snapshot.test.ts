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

describe("buildThreadSnapshot parent", () => {
  it("loads a nested subagent parent by id", async () => {
    const repos = createInMemoryRepositories();
    const parent = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      title: "Muse chat",
    });
    const child = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: parent.id as ThreadId,
      rootThreadId: parent.id as ThreadId,
      spawnDepth: 1,
      title: "Critic",
    });
    const nested = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: child.id as ThreadId,
      rootThreadId: parent.id as ThreadId,
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

    expect(snapshot.parent).toEqual({ id: child.id, title: "Critic" });
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
});
