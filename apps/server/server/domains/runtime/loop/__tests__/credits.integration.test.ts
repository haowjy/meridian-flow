/** Runtime credit-gate integration tests for ledger exhaustion and checkpoint meter-pause semantics. */

import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
} from "../../../threads/index.js";
import type { Gateway, GenerateResult, StreamEvent } from "../../gateway/index.js";
import {
  type CheckpointToolHandlerContext,
  createToolExecutor,
  createToolRegistry,
  type ToolHandler,
} from "../../tools/index.js";
import { createCheckpointRegistry } from "../checkpoints.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

async function collectEvents(handle: { events: AsyncIterable<OrchestratorEvent> }) {
  const events: OrchestratorEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function pricedTextResult(text = "done"): GenerateResult {
  return {
    content: [{ type: "text", text }],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    model: "gpt-4.1-mini",
    provider: "openai",
  };
}

async function setup(gateway: Gateway) {
  const projectRepo = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects: projectRepo });
  const project = await projectRepo.create({ userId: "user-1", title: "WB" });
  const creditLedger = createInMemoryCreditLedger();
  const eventWriter = createInMemoryEventJournalWriter();
  const checkpointRegistry = createCheckpointRegistry();
  const hub = createThreadEventHub({
    journalWriter: eventWriter,
    journalReader: eventWriter,
    eventSink: createInMemoryEventSink(),
  });
  const registry = createToolRegistry();
  const toolExecutor = createToolExecutor(registry);
  const orchestrator = createOrchestrator(
    createTestOrchestratorDeps({
      gateway,
      toolExecutor,
      repos,
      eventWriter: hub,
      checkpointRegistry,
      creditLedger,
      eventSink: createInMemoryEventSink(),
    }),
  );
  const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
  return { repos, thread, creditLedger, orchestrator, registry, eventWriter, checkpointRegistry };
}

describe("runtime credits", () => {
  it("allows one turn at exact zero balance before blocking negative balances", async () => {
    const gateway: Gateway = {
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "end", result: pricedTextResult() };
      },
      async generate() {
        throw new Error("not used");
      },
    };
    const { thread, creditLedger, orchestrator } = await setup(gateway);
    await creditLedger.grant({
      userId: "user-1",
      projectId: thread.projectId,
      source: "manual",
      amountMillicredits: "200000",
      reason: "single call",
    });

    const completed = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "first" }),
    );
    expect(completed.at(-1)?.type).toBe("turn.completed");
    expect(await creditLedger.getBalance({ userId: "user-1", projectId: thread.projectId })).toBe(
      "0",
    );

    const second = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "second" }),
    );
    expect(second.at(-1)?.type).toBe("turn.completed");
    expect(await creditLedger.getBalance({ userId: "user-1", projectId: thread.projectId })).toBe(
      "-200000",
    );

    await expect(
      orchestrator.runTurn({ threadId: thread.id, userText: "third" }),
    ).rejects.toMatchObject({
      code: "credits_exhausted",
      retryable: false,
      source: "system",
    });
  });

  it("does not debit additional credits while parked on a checkpoint", async () => {
    let call = 0;
    const gateway: Gateway = {
      async *stream(): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield {
            type: "end",
            result: {
              content: [{ type: "tool_use", toolCallId: "cp-call", toolName: "park", input: {} }],
              toolCalls: [],
              finishReason: "tool_use",
              usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
              model: "gpt-4.1-mini",
              provider: "openai",
            },
          };
          return;
        }
        yield { type: "end", result: pricedTextResult("resumed") };
      },
      async generate() {
        throw new Error("not used");
      },
    };
    const { thread, creditLedger, orchestrator, registry, eventWriter, checkpointRegistry } =
      await setup(gateway);
    await creditLedger.grant({
      userId: "user-1",
      projectId: thread.projectId,
      source: "manual",
      amountMillicredits: "1000000",
      reason: "checkpoint",
    });
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "park",
        description: "parks",
        inputSchema: { type: "object", properties: {} },
      },
      capability: "checkpoint",
      execution: {
        type: "server",
        handler: (async (_input, ctx: CheckpointToolHandlerContext) =>
          ctx.checkpoint({
            checkpointId: "cp-1",
            prompt: "pause",
            artifacts: [],
            answerSchema: { type: "object", properties: {} },
            requiresHuman: true,
          })) as ToolHandler<CheckpointToolHandlerContext>,
      },
    });

    const handle = await orchestrator.runTurn({ threadId: thread.id, userText: "park" });
    const eventsPromise = collectEvents(handle);
    await waitForEvent(eventWriter, thread.id, "checkpoint.created");
    expect(
      await creditLedger.getRunDebitTotal({
        userId: "user-1",
        projectId: thread.projectId,
        rootThreadId: thread.id,
      }),
    ).toBe("200000");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await creditLedger.getRunDebitTotal({
        userId: "user-1",
        projectId: thread.projectId,
        rootThreadId: thread.id,
      }),
    ).toBe("200000");

    checkpointRegistry.resolve({
      threadId: thread.id,
      turnId: handle.assistantTurnId,
      checkpointId: "cp-1",
      value: {},
    });
    await eventsPromise;
  });
});

async function waitForEvent(
  writer: ReturnType<typeof createInMemoryEventJournalWriter>,
  threadId: string,
  type: OrchestratorEvent["type"],
) {
  const started = Date.now();
  while (!writer.getEvents(threadId).some((entry) => entry.event.type === type)) {
    if (Date.now() - started > 2000) throw new Error(`timeout waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
