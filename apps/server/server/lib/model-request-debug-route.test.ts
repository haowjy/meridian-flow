// @ts-nocheck
/** Route-core tests for model-request debug capture: owner gating and capture enablement. */
import { describe, expect, it } from "vitest";
import {
  createInMemoryModelRequestDebugStore,
  createNoopModelRequestDebugStore,
} from "../domains/runtime/model-request-debug/index.js";
import { createInMemoryRepositories } from "../domains/threads/index.js";
import { createInMemoryWorkbenchRepository } from "../domains/workbenches/index.js";
import { handleGetModelRequestDebugRecords } from "./model-request-debug-route.js";

describe("model-request debug route core", () => {
  it("returns 404 when capture is disabled", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    const workbench = await workbenchRepo.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      id: "thread-1",
      workbenchId: workbench.id,
      userId: "user-1",
      title: null,
    });

    await expect(
      handleGetModelRequestDebugRecords(
        {
          repos,
          workbenchRepo,
          modelRequestDebug: createNoopModelRequestDebugStore(),
        },
        { threadId: thread.id, userId: "user-1" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns 404 for non-owner before listing records", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    const workbench = await workbenchRepo.create({ userId: "owner", title: "WB" });
    const thread = await repos.threads.create({
      id: "thread-1",
      workbenchId: workbench.id,
      userId: "owner",
      title: null,
    });
    const store = createInMemoryModelRequestDebugStore();
    store.record({
      threadId: thread.id,
      turnId: "turn-1",
      iteration: 0,
      requestedAt: "2026-06-10T12:00:00.000Z",
      agentSlug: null,
      model: "mock",
      provider: null,
      reasoning: null,
      systemMessages: ["system"],
      skills: [],
      tools: [],
      messageCount: 1,
    });

    await expect(
      handleGetModelRequestDebugRecords(
        { repos, workbenchRepo, modelRequestDebug: store },
        { threadId: thread.id, userId: "intruder" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns records for owner when capture is enabled", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    const workbench = await workbenchRepo.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      id: "thread-1",
      workbenchId: workbench.id,
      userId: "user-1",
      title: null,
    });
    const store = createInMemoryModelRequestDebugStore();
    const record = {
      threadId: thread.id,
      turnId: "turn-a",
      iteration: 0,
      requestedAt: "2026-06-10T12:00:00.000Z",
      agentSlug: "agent-one",
      model: "mock",
      provider: null,
      reasoning: null,
      systemMessages: ["Agent body"],
      skills: [],
      tools: [],
      messageCount: 2,
    };
    store.record(record);
    store.record({ ...record, turnId: "turn-b", iteration: 0 });

    await expect(
      handleGetModelRequestDebugRecords(
        { repos, workbenchRepo, modelRequestDebug: store },
        { threadId: thread.id, userId: "user-1", turnId: "turn-a" },
      ),
    ).resolves.toEqual({ records: [record] });
  });
});
