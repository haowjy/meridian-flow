/** System updates reuse transcript turns and coalesce while a model turn is active. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  TurnStartConflictError,
} from "../../threads/index.js";
import { createSystemUpdateDelivery } from "./system-update-delivery.js";

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
    const delivery = createSystemUpdateDelivery({
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      workContext: {
        async renderForThread() {
          return "<work_context>\ncurrent: book-1\n</work_context>";
        },
      },
      isThreadRunning: () => running,
    });

    await delivery.threadChanged(thread.id);
    await delivery.threadChanged(thread.id);
    expect(await repos.turns.listByThread(thread.id)).toEqual([]);

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
      "<system_update>\n<work_context>\ncurrent: book-1\n</work_context>\n</system_update>",
    );
    await expect(repos.threads.findById(thread.id)).resolves.toMatchObject({
      composedSystemPrompt: "Frozen prompt",
      bakedSkillSlugs: [],
    });
  });

  it("targets live project threads but not archived threads", async () => {
    const projectId = "00000000-0000-4000-8000-000000000120" as ProjectId;
    const activeId = "00000000-0000-4000-8000-000000000121" as ThreadId;
    const archivedId = "00000000-0000-4000-8000-000000000122" as ThreadId;
    const changed: string[] = [];
    const delivery = createSystemUpdateDelivery({
      repos: {
        threads: {
          async listByProject() {
            return [
              { id: activeId, status: "idle", bakedSkillSlugs: [] },
              { id: archivedId, status: "archived", bakedSkillSlugs: [] },
            ];
          },
          async findById(threadId: ThreadId) {
            return threadId === activeId
              ? { id: activeId, status: "idle", bakedSkillSlugs: [] }
              : { id: archivedId, status: "archived", bakedSkillSlugs: [] };
          },
        },
      } as never,
      eventWriter: {} as never,
      workContext: {} as never,
      isThreadRunning: () => true,
    });
    const original = delivery.threadChanged;
    delivery.threadChanged = async (threadId) => {
      changed.push(threadId);
      await original(threadId);
    };

    await delivery.projectChanged(projectId);
    expect(changed).toEqual([activeId]);
  });

  it("does not add an update before a thread has frozen its first prompt", async () => {
    const threadId = "00000000-0000-4000-8000-000000000123" as ThreadId;
    let contextReads = 0;
    const delivery = createSystemUpdateDelivery({
      repos: {
        threads: {
          async findById() {
            return { status: "idle", bakedSkillSlugs: null };
          },
        },
      } as never,
      eventWriter: {} as never,
      workContext: {
        async renderForThread() {
          contextReads += 1;
          return "unused";
        },
      },
      isThreadRunning: () => false,
    });

    await delivery.threadChanged(threadId);
    expect(contextReads).toBe(0);
  });

  it("retries from the new active head when a concurrent turn start wins", async () => {
    const threadId = "00000000-0000-4000-8000-000000000124" as ThreadId;
    const expectedHeads: Array<string | null> = [];
    let headRead = 0;
    const delivery = createSystemUpdateDelivery({
      repos: {
        turns: {
          async getLatestByThread() {
            return { id: headRead++ === 0 ? "old-head" : "new-turn-head" };
          },
          async findById() {
            return null;
          },
          async create() {},
        },
        blocks: { async upsert() {} },
        modelResponses: {},
        threads: { async updateActiveLeafTurn() {} },
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
});
