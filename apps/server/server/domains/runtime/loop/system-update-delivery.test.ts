/** System updates reuse transcript turns and coalesce while a model turn is active. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  TurnStartConflictError,
} from "../../threads/index.js";
import { isJsonObject } from "./block-helpers.js";
import { createSystemUpdateDelivery } from "./system-update-delivery.js";

async function pendingDeliveryFixture() {
  const projects = createInMemoryProjectRepository();
  const project = await projects.create({ userId: "user-1", title: "Serial" });
  const repos = createInMemoryRepositories({ projects });
  const thread = await repos.threads.create({
    userId: "user-1",
    projectId: project.id,
    title: "Chapter",
  });
  await repos.threads.bakeComposedSystemPrompt(thread.id, {
    composedSystemPrompt: "Frozen prompt",
    bakedSkillSlugs: [],
  });
  const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });
  const pendingBlock = await repos.blocks.create({
    turnId: turn.id,
    blockType: "tool_result",
    sequence: 0,
    content: {
      toolCallId: "work-call",
      output: {
        schema: "meridian.work.v1",
        result: { slug: "target" },
        contextUpdate: { status: "pending", message: "retry me" },
      },
      metadata: {
        workContextChanged: true,
        workContextDelivery: "pending",
        workContextWarning: "retry me",
      },
    },
  });
  const eventWriter = createInMemoryEventJournalWriter();
  const createDelivery = (writer = eventWriter) =>
    createSystemUpdateDelivery({
      repos,
      eventWriter: writer,
      workContext: {
        async renderForThread() {
          return "<work_context>current: target</work_context>";
        },
      },
      isThreadRunning: () => false,
    });
  await repos.workContextDeliveries.enqueueThread(thread.id);
  return { repos, thread, pendingBlock, eventWriter, createDelivery };
}

describe("createSystemUpdateDelivery", () => {
  it("appends one tagged user-role message after coalesced changes without rebaking", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "Chapter",
      systemPrompt: "Original prompt",
    });
    const workId = "00000000-0000-4000-8000-000000000111";
    await repos.threadWorks.addMembership(thread.id, workId, true);
    await repos.threads.bakeComposedSystemPrompt(thread.id, {
      composedSystemPrompt: "Frozen prompt",
      bakedSkillSlugs: [],
    });
    let running = true;
    let currentWork = "book-1";
    const delivery = createSystemUpdateDelivery({
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      workContext: {
        async renderForThread() {
          return `<work_context>\ncurrent: ${currentWork}\n</work_context>`;
        },
      },
      isThreadRunning: () => running,
    });

    await delivery.threadChanged(thread.id);
    await delivery.threadChanged(thread.id);
    expect(await repos.turns.listByThread(thread.id)).toEqual([]);

    currentWork = "book-2";
    running = false;
    await delivery.flush(thread.id);

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      role: "user",
      status: "complete",
      metadata: { kind: "system_update", section: "work_context" },
    });
    const blocks = await repos.blocks.listByTurn(turns[0]?.id ?? "");
    expect(blocks[0]?.textContent).toBe(
      "<system_update>\n<work_context>\ncurrent: book-2\n</work_context>\n</system_update>",
    );
    await expect(repos.threads.findById(thread.id)).resolves.toMatchObject({
      composedSystemPrompt: "Frozen prompt",
      bakedSkillSlugs: [],
    });
  });

  it("targets live project threads but not archived threads", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const active = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "Active",
    });
    const archived = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "Archived",
    });
    await repos.threads.bakeComposedSystemPrompt(active.id, {
      composedSystemPrompt: "Frozen",
      bakedSkillSlugs: [],
    });
    await repos.threads.bakeComposedSystemPrompt(archived.id, {
      composedSystemPrompt: "Frozen",
      bakedSkillSlugs: [],
    });
    await repos.threads.updateStatus(archived.id, "archived");
    const delivery = createSystemUpdateDelivery({
      repos,
      eventWriter: {} as never,
      workContext: {} as never,
      isThreadRunning: () => true,
    });

    await delivery.projectChanged(project.id);
    await expect(repos.workContextDeliveries.isPending(active.id)).resolves.toBe(true);
    await expect(repos.workContextDeliveries.isPending(archived.id)).resolves.toBe(false);
  });

  it("does not add an update before a thread has frozen its first prompt", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "Unfrozen",
    });
    const delivery = createSystemUpdateDelivery({
      repos,
      eventWriter: {} as never,
      workContext: {} as never,
      isThreadRunning: () => false,
    });

    await delivery.threadChanged(thread.id);
    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(false);
  });

  it("retries from the new active head when a concurrent turn start wins", async () => {
    const threadId = "00000000-0000-4000-8000-000000000124" as ThreadId;
    const expectedHeads: Array<string | null> = [];
    let headRead = 0;
    const delivery = createSystemUpdateDelivery({
      repos: {
        turns: {
          // These chronological rows share a timestamp and put the user row
          // last. It is deliberately not the logical head.
          async getLatestByThread() {
            return { id: "same-time-user-turn", createdAt: "2026-08-06T12:00:00.000Z" };
          },
          async findById() {
            return null;
          },
          async create() {},
        },
        blocks: {
          async upsert() {},
          async listByThread() {
            return [];
          },
        },
        modelResponses: {},
        workContextDeliveries: {
          async lockPending() {
            return true;
          },
          async acknowledge() {},
        },
        threads: {
          async findById() {
            return {
              id: threadId,
              activeLeafTurnId: headRead++ === 0 ? "old-head" : "new-turn-head",
            };
          },
          async updateActiveLeafTurn() {},
        },
        async transaction(operation: () => Promise<unknown>) {
          return operation();
        },
        async runTurnStartTransition(
          _threadId: ThreadId,
          expected: string | null,
          operation: () => Promise<unknown>,
        ) {
          expectedHeads.push(expected);
          if (expectedHeads.length === 1) {
            throw new TurnStartConflictError(threadId, "already_running");
          }
          return operation();
        },
      } as never,
      eventWriter: { async appendEvent() {} } as never,
      workContext: {
        async renderForThread() {
          return "fresh";
        },
      },
      isThreadRunning: () => true,
    });

    const update = await delivery.deliverNow(threadId);
    expect(expectedHeads).toEqual(["old-head", "new-turn-head"]);
    expect(update.turn.prevTurnId).toBe("new-turn-head");
  });

  it("recovers a durable obligation after the delivery instance is recreated", async () => {
    const { repos, thread, pendingBlock, createDelivery } = await pendingDeliveryFixture();

    await createDelivery().flush(thread.id);

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.at(-1)?.metadata).toEqual({ kind: "system_update", section: "work_context" });
    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(false);
    await expect(repos.blocks.findById(pendingBlock.id)).resolves.toMatchObject({
      content: { metadata: { workContextDelivery: "delivered" } },
    });
  });

  it("keeps delivery pending through two consecutive append failures", async () => {
    const { repos, thread, pendingBlock, eventWriter, createDelivery } =
      await pendingDeliveryFixture();
    let failuresRemaining = 2;
    const failingWriter = {
      ...eventWriter,
      async appendEvent(...args: Parameters<typeof eventWriter.appendEvent>) {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("journal unavailable");
        }
        return eventWriter.appendEvent(...args);
      },
    };
    const delivery = createDelivery(failingWriter);

    await expect(delivery.flush(thread.id)).rejects.toThrow("journal unavailable");
    await expect(delivery.flush(thread.id)).rejects.toThrow("journal unavailable");
    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(true);
    await expect(repos.blocks.findById(pendingBlock.id)).resolves.toMatchObject({
      content: { metadata: { workContextDelivery: "pending" } },
    });

    await delivery.flush(thread.id);
    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(false);
    await expect(repos.blocks.findById(pendingBlock.id)).resolves.toMatchObject({
      content: { metadata: { workContextDelivery: "delivered" } },
    });
  });

  it("serializes concurrent recovery claims and acknowledges exactly once", async () => {
    const { repos, thread, eventWriter, createDelivery } = await pendingDeliveryFixture();
    const firstProcess = createDelivery();
    const secondProcess = createDelivery();

    await Promise.all([firstProcess.beforeTurn(thread.id), secondProcess.beforeTurn(thread.id)]);

    const updates = (await repos.turns.listByThread(thread.id)).filter(
      (turn) =>
        turn.metadata !== undefined &&
        isJsonObject(turn.metadata) &&
        turn.metadata.kind === "system_update",
    );
    expect(updates).toHaveLength(1);
    const replay = await eventWriter.readAfter(thread.id, 0n);
    expect(replay.filter((entry) => entry.payload.type === "turn.created")).toHaveLength(1);
    expect(
      replay.filter(
        (entry) => entry.payload.type === "tool.result" && entry.payload.toolCallId === "work-call",
      ),
    ).toHaveLength(1);
    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(false);
  });
});
