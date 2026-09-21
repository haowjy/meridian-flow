/**
 * The single cancel exit: a cancel observed inside a tool batch finalizes the
 * turn through one path (roll back the active response, then cancel) with no
 * fall-through into another provider stream.
 */

import { describe, expect, it, vi } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import { createInMemoryRepositories } from "../../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunAuthority,
  createInMemoryThreadLock,
} from "../../adapters/in-memory/loop-ports.js";
import type { Gateway, GenerateResult, StreamEvent } from "../../gateway/index.js";
import { createOrchestrator } from "../orchestrator.js";
import { gatewayStubDefaults } from "./test-gateway.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

const USER_ID = "user-1";

function toolUseResult(toolName: string, toolCallId: string): GenerateResult {
  return {
    content: [{ type: "tool_use", toolCallId, toolName, input: {} }],
    toolCalls: [],
    finishReason: "tool_use",
    usage: { inputTokens: 1_000, outputTokens: 1_000 },
    model: "gpt-4.1-mini",
    provider: "openai",
  };
}

describe("single cancel exit", () => {
  it("finalizes once when a tool batch cancels, without starting another stream", async () => {
    const projects = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects });
    const project = await projects.create({ userId: USER_ID, title: "Cancel" });
    const thread = await repos.threads.create({ userId: USER_ID, projectId: project.id });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: USER_ID,
      source: "manual",
      amountMillicredits: "1000000",
      reason: "cancel exit",
    });

    const controller = new AbortController();
    let streams = 0;
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(): AsyncGenerator<StreamEvent> {
        streams += 1;
        yield { type: "end", result: toolUseResult("ask_user", "call-1") };
      },
      async generate() {
        throw new Error("not used");
      },
    };
    const rollback = vi.fn(async () => {});
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        boundThreads: () => [thread.id],
        gateway,
        repos,
        creditLedger,
        inbox: createInMemoryInbox(),
        threadLock: createInMemoryThreadLock(),
        runAuthority: createInMemoryRunAuthority(),
        toolExecutor: {
          async executeTool(call) {
            // The writer cancels while the tool is in flight; the loop must exit
            // through the single cancel path instead of streaming again.
            controller.abort();
            return { toolCallId: call.id, output: { ok: true } };
          },
        },
        responseWrites: {
          async commitResponse() {
            return { status: "committed", receipts: [], concurrentEdits: [] };
          },
          async rollbackResponse() {
            rollback();
          },
        },
      }),
    );

    const events: Array<{ type: string }> = [];
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "cancel mid-batch",
      signal: controller.signal,
    });
    for await (const event of handle.events) events.push(event);

    expect(streams).toBe(1);
    expect(events.at(-1)?.type).toBe("turn.cancelled");
    expect(rollback).toHaveBeenCalledTimes(1);

    const turns = await repos.turns.listByThread(thread.id);
    const assistants = turns.filter((turn) => turn.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.status).toBe("cancelled");
  });
});
