/** Direct child results preserve the saved terminal outcome and partial content. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunAuthority,
  createInMemoryThreadLock,
} from "../adapters/in-memory/loop-ports.js";
import { closeRun } from "../loop/close-run.js";
import type { RunAuthority } from "../loop/ports.js";
import { createChildRunDriver } from "./child-run-driver.js";
import { savedReportToSpawnResult } from "./saved-report-outcome.js";

function saved(overrides: Partial<SavedExecutionReport> = {}): SavedExecutionReport {
  return {
    childThreadId: "child-id",
    assistantTurnId: "execution-id",
    handle: "p3",
    origin: "spawn",
    deliveryMode: "direct",
    callerThreadId: "parent-id",
    callerTurnId: "parent-turn",
    toolCallId: "spawn-call",
    cardBlockId: "card-id",
    agentSlug: "critic",
    description: null,
    capture: null,
    captureToolCallId: null,
    outcome: "succeeded",
    reason: null,
    source: "final_assistant",
    summary: "final public text",
    artifacts: null,
    costMillicredits: 42,
    terminalAt: "2026-01-01T00:00:00.000Z",
    publication: "published",
    publishedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("savedReportToSpawnResult", () => {
  it("returns exact successful execution content and cost", () => {
    expect(savedReportToSpawnResult(saved())).toEqual({
      status: "completed",
      execution: "execution-id",
      outcome: "succeeded",
      report: {
        handle: "p3",
        threadId: "child-id",
        summary: "final public text",
        costMillicredits: 42,
      },
    });
  });

  it("keeps a failed captured candidate as partial content, not success", () => {
    const result = savedReportToSpawnResult(
      saved({
        outcome: "failed",
        reason: "max_tokens",
        source: "return_result",
        summary: "partial candidate",
        payload: { retained: true },
      }),
    );
    expect(result).toMatchObject({
      status: "error",
      execution: "execution-id",
      outcome: "failed",
      partial: true,
      reason: "max_tokens",
      report: { summary: "partial candidate", payload: { retained: true } },
    });
  });

  it("keeps cancellation distinct and refuses a nonterminal row", () => {
    const cancelled = savedReportToSpawnResult(
      saved({ outcome: "cancelled", reason: "cancelled" }),
    );
    expect(cancelled).toMatchObject({
      status: "error",
      outcome: "cancelled",
      error: { code: "spawn_cancelled" },
    });
    expect(() => savedReportToSpawnResult(saved({ outcome: null }))).toThrow("not terminal");
  });
});

describe("ChildRunDriver lease ownership", () => {
  it("retries physical release in the owner's finally after a terminal unlock callback fails", async () => {
    const repos = createInMemoryRepositories();
    const parent = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const callerTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      status: "complete",
      prevTurnId: null,
    });
    const child = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      originTurnId: callerTurn.id,
      spawnDepth: 1,
    });
    const underlying = createInMemoryRunAuthority();
    let releaseCalls = 0;
    let unlockCalls = 0;
    const physicalUnlock = async (lease: Parameters<RunAuthority["release"]>[0]) => {
      unlockCalls += 1;
      if (unlockCalls === 1) throw new Error("physical unlock failed");
      await underlying.release(lease);
    };
    const runAuthority: RunAuthority = {
      ...underlying,
      async release(lease) {
        releaseCalls += 1;
        // Model the adapter's postcommit allSettled callback: the first
        // physical unlock fails without throwing from committed terminal A.
        if (releaseCalls === 1) {
          await Promise.allSettled([physicalUnlock(lease)]);
          return;
        }
        await physicalUnlock(lease);
      },
    };
    const threadLock = createInMemoryThreadLock();
    const inbox = createInMemoryInbox();
    const execution = crypto.randomUUID() as TurnId;
    const driver = createChildRunDriver({
      orchestrator: {
        async runTurn(input) {
          const userTurn = await repos.turns.create({
            threadId: input.threadId,
            role: "user",
            status: "complete",
            prevTurnId: null,
          });
          await repos.turns.create({
            id: execution,
            threadId: input.threadId,
            role: "assistant",
            status: "streaming",
            prevTurnId: userTurn.id,
          });
          if (!input.executionReport) throw new Error("missing report correlation");
          await repos.executionReports.admit({
            childThreadId: input.threadId,
            assistantTurnId: execution,
            handle: child.ref ?? "",
            ...input.executionReport.correlation,
          });
          return {
            userTurnId: userTurn.id,
            assistantTurnId: execution,
            events: (async function* () {
              await closeRun({
                threadLock,
                inbox,
                runAuthority,
                threadId: input.threadId,
                lease: input.lease ?? null,
                continueOnPending: false,
                complete: async () => {
                  await repos.executionReports.finalizeOnce({
                    childThreadId: input.threadId,
                    assistantTurnId: execution,
                    outcome: "succeeded",
                    reason: null,
                    source: "empty",
                    summary: "",
                    costMillicredits: 0,
                  });
                },
              });
              yield* [] as OrchestratorEvent[];
            })(),
          };
        },
        async finalizeGeneratorFailure() {},
      },
      repos: { executionReports: repos.executionReports },
      eventWriter: {
        async appendEvent() {
          return 1n;
        },
      },
      readActivity: async () => ({ descendants: [] }),
      childRunRegistry: {
        registerChild() {},
        registerBackgroundChild() {},
        unregisterChild() {},
        markChildTurn() {},
        abortChild() {},
        abortChildrenOf() {},
      },
      workContextDelivery: { async flushOwned() {} },
      runAuthority,
      publisher: {
        async publish() {
          return "published";
        },
      },
      eventSink: createInMemoryEventSink(),
    });
    const prepared = await driver.register(child, "general", { origin: "spawn" });
    const result = await driver.drive(prepared, {
      parentThread: parent,
      parentTurnId: callerTurn.id,
      prompt: "write",
      budget: createDefaultTreeBudget(),
      reportCorrelation: {
        callerThreadId: parent.id as ThreadId,
        callerTurnId: callerTurn.id,
        toolCallId: "spawn-call",
        cardBlockId: null,
        origin: "spawn",
        deliveryMode: "direct",
      },
    });
    expect(result.status).toBe("completed");
    expect(releaseCalls).toBe(2);
    expect(unlockCalls).toBe(2);
    expect(await underlying.holder(child.id)).toBeNull();
  });
});
