import { describe, expect, it } from "vitest";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import { createHelperResultDelivery } from "./helper-result-delivery.js";

describe("createHelperResultDelivery", () => {
  it("queues helper results while the parent thread is streaming and delivers as a system turn", async () => {
    const repos = createInMemoryRepositories();
    const eventWriter = createInMemoryEventJournalWriter();
    const parent = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      workId: "work-1",
      currentAgent: "muse",
    });
    const parentTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      status: "streaming",
    });

    const running = new Map<string, string>([[parent.id, parentTurn.id]]);
    const delivery = createHelperResultDelivery({
      repos,
      eventWriter,
      getRunningTurnId: (threadId) => (running.get(threadId) as never) ?? null,
    });

    await delivery.deliverOrQueue({
      parentThread: parent,
      parentTurnId: parentTurn.id,
      agentSlug: "writer-helper",
      childThreadId: "child-1",
      result: {
        status: "completed",
        report: {
          threadId: "child-1",
          summary: "Draft A is stronger.",
          costMillicredits: 0,
        },
      },
    });

    expect(await repos.turns.listByThread(parent.id)).toHaveLength(1);
    expect(await repos.blocks.listByTurn(parentTurn.id)).toHaveLength(0);

    running.delete(parent.id);
    await delivery.flush(parent.id);

    const turns = await repos.turns.listByThread(parent.id);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ role: "system", status: "complete" });
    const helperBlocks = await repos.blocks.listByTurn(turns[1]?.id ?? "missing");
    expect(helperBlocks[0]?.content).toMatchObject({
      kind: "helper-result",
      props: { agentSlug: "writer-helper", summary: "Draft A is stronger." },
    });
    expect(await repos.blocks.listByTurn(parentTurn.id)).toHaveLength(0);
  });

  it("delivers immediately when the parent thread is idle", async () => {
    const repos = createInMemoryRepositories();
    const eventWriter = createInMemoryEventJournalWriter();
    const parent = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      workId: "work-1",
      currentAgent: "muse",
    });
    const parentTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      status: "complete",
    });

    const delivery = createHelperResultDelivery({
      repos,
      eventWriter,
      getRunningTurnId: () => null,
    });

    await delivery.deliverOrQueue({
      parentThread: parent,
      parentTurnId: parentTurn.id,
      agentSlug: "writer-helper",
      childThreadId: "child-1",
      result: {
        status: "completed",
        report: { threadId: "child-1", summary: "Done.", costMillicredits: 0 },
      },
    });

    const turns = await repos.turns.listByThread(parent.id);
    expect(turns.at(-1)).toMatchObject({ role: "system" });
    expect(await repos.blocks.listByTurn(parentTurn.id)).toHaveLength(0);
  });

  it("tracks directly driven child turns as running until explicitly marked idle", async () => {
    const repos = createInMemoryRepositories();
    const eventWriter = createInMemoryEventJournalWriter();
    const parent = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      workId: "work-1",
    });
    const parentTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      status: "streaming",
    });
    const delivery = createHelperResultDelivery({
      repos,
      eventWriter,
      getRunningTurnId: () => null,
    });

    delivery.markRunning(parent.id, parentTurn.id);
    await delivery.deliverOrQueue({
      parentThread: parent,
      parentTurnId: parentTurn.id,
      agentSlug: "writer-helper",
      childThreadId: "child-1",
      result: {
        status: "completed",
        report: { threadId: "child-1", summary: "Nested done.", costMillicredits: 0 },
      },
    });
    expect(await repos.turns.listByThread(parent.id)).toHaveLength(1);

    await delivery.markIdleAndFlush(parent.id);
    expect(await repos.turns.listByThread(parent.id)).toHaveLength(2);
  });
});
