/**
 * The single cancel exit: a cancel observed inside a tool batch finalizes the
 * turn through one path (roll back the active response, then cancel) with no
 * fall-through into another provider stream.
 */

import { describe, expect, it, vi } from "vitest";
import type { Gateway, GenerateResult, StreamEvent } from "../../gateway/index.js";
import { runtimeScenario } from "./runtime-harness.js";
import { gatewayStubDefaults } from "./test-gateway.js";

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
    const { orchestrator, repos, thread } = await runtimeScenario({
      gateway,
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
    });

    const handle = await orchestrator.prepare({
      threadId: thread.id,
      userText: "cancel mid-batch",
      signal: controller.signal,
    });
    const outcome = await handle.execute();

    expect(streams).toBe(1);
    expect(outcome.status).toBe("cancelled");
    expect(rollback).toHaveBeenCalledTimes(1);

    const turns = await repos.turns.listByThread(thread.id);
    const assistants = turns.filter((turn) => turn.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.status).toBe("cancelled");
  });
});
