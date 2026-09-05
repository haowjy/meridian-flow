/** System updates reuse transcript turns and coalesce while a model turn is active. */

import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { testWorkSlug } from "../../../test-support/work-slug.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  TurnStartConflictError,
} from "../../threads/index.js";
import { isJsonObject } from "./block-helpers.js";
import { createWorkContextDelivery } from "./work-context-delivery.js";

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
    createWorkContextDelivery({
      repos,
      eventWriter: writer,
      workContext: {
        async renderForThread() {
          return {
            text: "<work_context>current: target</work_context>",
            current: {
              projectId: "00000000-0000-0000-0000-000000000001",
              execution: {
                scope: {
                  kind: "work",
                  workId: "00000000-0000-0000-0000-000000000002",
                  workSlug: testWorkSlug("test-work"),
                },
                aiWriteMode: "direct",
                draftOwner: null,
              },
            },
          };
        },
      },
      isThreadRunning: () => false,
      schedulePostCommit() {},
    });
  await repos.workContextDeliveries.enqueueThread(thread.id);
  return { repos, thread, pendingBlock, eventWriter, createDelivery };
}

describe("createWorkContextDelivery", () => {
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
    const eventWriter = createInMemoryEventJournalWriter();
    const delivery = createWorkContextDelivery({
      repos,
      eventWriter,
      workContext: {
        async renderForThread() {
          return {
            text: `<work_context>\ncurrent: ${currentWork}\n</work_context>`,
            current: {
              projectId: project.id,
              execution: {
                scope: { kind: "work", workId, workSlug: testWorkSlug(currentWork) },
                aiWriteMode: "direct",
                draftOwner: null,
              },
            },
          };
        },
      },
      isThreadRunning: () => running,
      schedulePostCommit() {},
    });

    await delivery.threadChanged(thread.id);
    await delivery.threadChanged(thread.id);
    expect(await repos.turns.listByThread(thread.id)).toEqual([]);

    currentWork = "book-2";
    running = false;
    await delivery.deliverAfterCommit(thread.id);

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      role: "user",
      status: "complete",
      metadata: {
        kind: "system_update",
        section: "work_context",
      },
    });
    const blocks = await repos.blocks.listByTurn(turns[0]?.id ?? "");
    expect(blocks[0]?.textContent).toBe(
      "<system_update>\n<work_context>\ncurrent: book-2\n</work_context>\n</system_update>",
    );
    await expect(eventWriter.readAfter(thread.id, 0n)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: turns[0]?.id,
          payload: {
            type: "work_context.changed",
            turnId: turns[0]?.id,
            threadId: thread.id,
            projectId: project.id,
            scope: { kind: "work", workId, workSlug: testWorkSlug("book-2") },
          },
        }),
      ]),
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
    const delivery = createWorkContextDelivery({
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      workContext: {
        async renderForThread() {
          throw new Error("delivery is held while the thread is running");
        },
      },
      isThreadRunning: () => true,
      schedulePostCommit() {},
    });

    await delivery.projectChanged(project.id);
    await expect(repos.workContextDeliveries.isPending(active.id)).resolves.toBe(true);
    await expect(repos.workContextDeliveries.isPending(archived.id)).resolves.toBe(false);
  });

  it("keeps an obligation when a Work changes before the first prompt freezes", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "Unfrozen",
    });
    const delivery = createWorkContextDelivery({
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      workContext: {
        async renderForThread() {
          throw new Error("scheduled delivery is not awaited by this test");
        },
      },
      isThreadRunning: () => false,
      schedulePostCommit() {},
    });

    await delivery.threadChanged(thread.id);
    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(true);
  });

  it("wakes an idle thread after enqueue without making the caller flush", async () => {
    const { repos, thread } = await pendingDeliveryFixture();
    const scheduled: Promise<void>[] = [];
    const delivery = createWorkContextDelivery({
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      workContext: {
        async renderForThread() {
          return {
            text: "<work_context>fresh</work_context>",
            current: {
              projectId: "00000000-0000-0000-0000-000000000001",
              execution: {
                scope: {
                  kind: "work",
                  workId: "00000000-0000-0000-0000-000000000002",
                  workSlug: testWorkSlug("test-work"),
                },
                aiWriteMode: "direct",
                draftOwner: null,
              },
            },
          };
        },
      },
      isThreadRunning: () => false,
      schedulePostCommit(task) {
        scheduled.push(task());
      },
    });

    await delivery.threadChanged(thread.id);
    await Promise.all(scheduled);

    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(false);
    const updates = (await repos.turns.listByThread(thread.id)).filter((turn) => {
      const metadata = turn.metadata ?? null;
      return isJsonObject(metadata) && metadata.kind === "system_update";
    });
    expect(updates).toHaveLength(1);
  });

  it("sweeps obligations after the delivery owner is recreated", async () => {
    const { repos, thread, createDelivery } = await pendingDeliveryFixture();

    await createDelivery().sweep();

    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(false);
    const updates = (await repos.turns.listByThread(thread.id)).filter((turn) => {
      const metadata = turn.metadata ?? null;
      return isJsonObject(metadata) && metadata.kind === "system_update";
    });
    expect(updates).toHaveLength(1);
  });

  it("retries from the new active head when a concurrent turn start wins", async () => {
    const threadId = "00000000-0000-4000-8000-000000000124" as ThreadId;
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const thread = await repos.threads.create({
      id: threadId,
      userId: "user-1",
      projectId: project.id,
      title: "Retry",
    });
    await repos.workContextDeliveries.enqueueThread(threadId);
    const expectedHeads: Array<string | null> = [];
    let headRead = 0;
    const delivery = createWorkContextDelivery({
      repos: {
        ...repos,
        threads: {
          ...repos.threads,
          async findById() {
            return {
              ...thread,
              activeLeafTurnId: headRead++ === 0 ? "old-head" : "new-turn-head",
            };
          },
        },
        async runTurnStartTransition<T>(
          _threadId: ThreadId,
          expected: string | null,
          operation: () => Promise<T>,
        ): Promise<T> {
          expectedHeads.push(expected);
          if (expectedHeads.length === 1) {
            throw new TurnStartConflictError(threadId, "already_running");
          }
          return operation();
        },
      },
      eventWriter: createInMemoryEventJournalWriter(),
      workContext: {
        async renderForThread() {
          return {
            text: "fresh",
            current: {
              projectId: "00000000-0000-0000-0000-000000000001",
              execution: {
                scope: {
                  kind: "work",
                  workId: "00000000-0000-0000-0000-000000000002",
                  workSlug: testWorkSlug("test-work"),
                },
                aiWriteMode: "direct",
                draftOwner: null,
              },
            },
          };
        },
      },
      isThreadRunning: () => true,
      schedulePostCommit() {},
    });

    const update = await delivery.deliverNow(threadId);
    expect(expectedHeads).toEqual(["old-head", "new-turn-head"]);
    expect(update.turn.prevTurnId).toBe("new-turn-head");
  });

  it("recovers a durable obligation after the delivery instance is recreated", async () => {
    const { repos, thread, pendingBlock, createDelivery } = await pendingDeliveryFixture();

    await createDelivery().deliverAfterCommit(thread.id);

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.at(-1)?.metadata).toEqual({ kind: "system_update", section: "work_context" });
    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(false);
    await expect(repos.blocks.findById(pendingBlock.id)).resolves.toMatchObject({
      content: { metadata: { workContextDelivery: "delivered" } },
    });
  });

  it("returns pending when status inspection fails after delivery", async () => {
    const { repos, thread, createDelivery } = await pendingDeliveryFixture();
    vi.spyOn(repos.workContextDeliveries, "isPending").mockRejectedValueOnce(
      new Error("status unavailable"),
    );

    await expect(createDelivery().deliverAfterCommit(thread.id)).resolves.toBe("pending");
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

    await expect(delivery.deliverAfterCommit(thread.id)).resolves.toBe("pending");
    await expect(delivery.deliverAfterCommit(thread.id)).resolves.toBe("pending");
    await expect(repos.workContextDeliveries.isPending(thread.id)).resolves.toBe(true);
    await expect(repos.blocks.findById(pendingBlock.id)).resolves.toMatchObject({
      content: { metadata: { workContextDelivery: "pending" } },
    });

    await delivery.deliverAfterCommit(thread.id);
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
