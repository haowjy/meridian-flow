import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryCreditLedger } from "../../billing/adapters/in-memory/credit-ledger.js";
import { createInMemoryPackageStore } from "../../packages/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import { createChildRunCoordinator } from "./child-run-coordinator.js";
import { createHelperResultDelivery } from "./helper-result-delivery.js";

function completeTurn(threadId: string): Turn {
  return {
    id: `turn-${threadId}`,
    threadId,
    role: "assistant",
    status: "complete",
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    createdAt: "2026-06-12T00:00:00.000Z",
    completedAt: "2026-06-12T00:00:00.000Z",
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

async function eventually<T>(read: () => Promise<T>, pass: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 30; i += 1) {
    const value = await read();
    if (pass(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const value = await read();
  expect(pass(value)).toBe(true);
  return value;
}

describe("ChildRunCoordinator background spawn", () => {
  it("returns immediately and posts background events plus an inline helper block", async () => {
    const repos = createInMemoryRepositories();
    const eventWriter = createInMemoryEventJournalWriter();
    const packageRepository = createInMemoryPackageStore({
      agents: [
        {
          id: "agent-muse",
          projectId: "project-1",
          slug: "muse",
          body: "Muse",
          meta: { subagents: ["writer-helper"] },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "builtin",
          enabled: true,
        },
        {
          id: "agent-writer-helper",
          projectId: "project-1",
          slug: "writer-helper",
          body: "Writer helper",
          meta: { mode: "subagent", subagents: [] },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "builtin",
          enabled: true,
        },
      ],
    });
    const creditLedger = createInMemoryCreditLedger();
    const parent = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      currentAgent: "muse",
    });
    await repos.threadWorks.addMembership(parent.id, "work-1", true);
    const parentTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      status: "complete",
    });

    const childRunRegistry = {
      registerChild: vi.fn(),
      registerBackgroundChild: vi.fn(),
      unregisterChild: vi.fn(),
      abortChild: vi.fn(),
      abortChildrenOf: vi.fn(),
    };

    const helperResultDelivery = createHelperResultDelivery({
      repos,
      eventWriter,
      getRunningTurnId: () => null,
    });

    const coordinator = createChildRunCoordinator({
      orchestrator: {
        async runTurn(input) {
          await input.returnResultCompleter?.({ summary: "Draft A is stronger." });
          return {
            userTurnId: `user-${input.threadId}`,
            assistantTurnId: `assistant-${input.threadId}`,
            events: (async function* () {
              yield { type: "turn.completed", turn: completeTurn(input.threadId) };
            })(),
          };
        },
      },
      repos: {
        threads: repos.threads,
        subagentThreads: repos.threads,
        turns: repos.turns,
        blocks: repos.blocks,
        transaction: repos.transaction,
        threadWorks: repos.threadWorks,
      },
      resolveWorkMembership: async ({ parentThreadId }) => {
        const primary = parentThreadId ? await repos.threadWorks.findPrimary(parentThreadId) : null;
        return primary?.workId ?? "work-1";
      },
      eventWriter,
      packageRepository,
      childRunRegistry,
      helperResultDelivery,
      creditLedger,
    });

    const result = await coordinator.spawnChildBackground({
      parentThread: parent,
      parentTurnId: parentTurn.id,
      agentSlug: "writer-helper",
      prompt: "Draft two openings.",
      description: "Draft A",
      budget: createDefaultTreeBudget(),
    });

    expect(result).toMatchObject({ status: "background", agentSlug: "writer-helper" });
    expect(childRunRegistry.registerChild).not.toHaveBeenCalled();
    expect(childRunRegistry.registerBackgroundChild).toHaveBeenCalledOnce();

    const completedEvents = await eventually(
      () => eventWriter.listByType(parent.id, "background.completed"),
      (events) => events.length === 1,
    );
    expect(completedEvents[0]?.payload).toMatchObject({
      type: "background.completed",
      agentSlug: "writer-helper",
    });

    const blocks = await eventually(
      () => repos.turns.listByThread(parent.id),
      (turns) => turns.some((turn) => turn.role === "system"),
    );
    const systemTurn = blocks.find((turn) => turn.role === "system");
    const helperBlocks = await repos.blocks.listByTurn(systemTurn?.id ?? "missing");
    expect(helperBlocks[0]?.content).toMatchObject({
      kind: "helper-result",
      props: { agentSlug: "writer-helper", summary: "Draft A is stronger." },
    });
  });

  it("aborts a background child when return_result completes", async () => {
    const repos = createInMemoryRepositories();
    const eventWriter = createInMemoryEventJournalWriter();
    const packageRepository = createInMemoryPackageStore({
      agents: [
        {
          id: "agent-muse",
          projectId: "project-1",
          slug: "muse",
          body: "Muse",
          meta: { subagents: ["writer-helper"] },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "builtin",
          enabled: true,
        },
        {
          id: "agent-writer-helper",
          projectId: "project-1",
          slug: "writer-helper",
          body: "Writer helper",
          meta: { mode: "subagent", subagents: [] },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "builtin",
          enabled: true,
        },
      ],
    });
    const parent = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      currentAgent: "muse",
    });
    await repos.threadWorks.addMembership(parent.id, "work-1", true);
    const parentTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      status: "complete",
    });
    const backgroundControllers = new Map<string, AbortController>();
    const childRunRegistry = {
      registerChild: vi.fn(),
      registerBackgroundChild: vi.fn(
        (parentThreadId: string, childThreadId: string, controller: AbortController) => {
          backgroundControllers.set(`${parentThreadId}:${childThreadId}`, controller);
        },
      ),
      unregisterChild: vi.fn(),
      abortChild: vi.fn((childThreadId: string) => {
        for (const [key, controller] of backgroundControllers) {
          if (key.endsWith(`:${childThreadId}`)) controller.abort();
        }
      }),
      abortChildrenOf: vi.fn(),
    };

    const helperResultDelivery = createHelperResultDelivery({
      repos,
      eventWriter,
      getRunningTurnId: () => null,
    });

    const coordinator = createChildRunCoordinator({
      orchestrator: {
        async runTurn(input) {
          await input.returnResultCompleter?.({ summary: "Done." });
          expect(input.signal?.aborted).toBe(true);
          return {
            userTurnId: `user-${input.threadId}`,
            assistantTurnId: `assistant-${input.threadId}`,
            events: (async function* () {
              yield { type: "turn.cancelled", turn: completeTurn(input.threadId) };
            })(),
          };
        },
      },
      repos: {
        threads: repos.threads,
        subagentThreads: repos.threads,
        turns: repos.turns,
        blocks: repos.blocks,
        transaction: repos.transaction,
        threadWorks: repos.threadWorks,
      },
      resolveWorkMembership: async ({ parentThreadId }) => {
        const primary = parentThreadId ? await repos.threadWorks.findPrimary(parentThreadId) : null;
        return primary?.workId ?? "work-1";
      },
      eventWriter,
      packageRepository,
      childRunRegistry,
      helperResultDelivery,
      creditLedger: createInMemoryCreditLedger(),
    });

    await coordinator.spawnChildBackground({
      parentThread: parent,
      parentTurnId: parentTurn.id,
      agentSlug: "writer-helper",
      prompt: "Draft two openings.",
      budget: createDefaultTreeBudget(),
    });

    await eventually(
      () => eventWriter.listByType(parent.id, "background.completed"),
      (events) => events.length === 1,
    );

    const [[parentThreadId, childThreadId, controller]] =
      childRunRegistry.registerBackgroundChild.mock.calls;
    expect(parentThreadId).toBe(parent.id);
    expect(childRunRegistry.abortChild).toHaveBeenCalledWith(childThreadId);
    expect(controller.signal.aborted).toBe(true);
    expect(childRunRegistry.unregisterChild).toHaveBeenCalledWith(childThreadId);
  });
});
