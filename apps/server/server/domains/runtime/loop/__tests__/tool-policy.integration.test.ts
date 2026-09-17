/** Per-turn permission gate denies tools missing from projected policy. */
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import { createInMemoryRepositories } from "../../../threads/index.js";
import type { Gateway, GenerateResult, StreamEvent } from "../../gateway/index.js";
import type { ToolCallInput, ToolExecutionContext } from "../../tools/index.js";
import { createOrchestrator } from "../orchestrator.js";
import { gatewayStubDefaults } from "./test-gateway.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

async function collectEvents(handle: { events: AsyncIterable<OrchestratorEvent> }) {
  const events: OrchestratorEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

describe("per-turn tool policy gate", () => {
  it("denies spawn without calling the executor", async () => {
    const calls: string[] = [];
    const results: GenerateResult[] = [
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "call-spawn",
            toolName: "spawn",
            input: { agent: "critic", prompt: "review" },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 8, outputTokens: 4 },
        model: "mock-model",
        provider: "mock",
      },
      {
        content: [{ type: "text", text: "ok" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 8, outputTokens: 4 },
        model: "mock-model",
        provider: "mock",
      },
    ];
    let stream = 0;
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      getDefaultModel: () => "mock-model",
      async *stream(_request: never): AsyncGenerator<StreamEvent> {
        const result = results[stream++];
        if (!result) throw new Error("unexpected stream");
        yield { type: "end", result };
      },
      async generate() {
        throw new Error("not used");
      },
    };
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        boundThreads: () => [thread.id],
        gateway,
        repos,
        creditLedger,
        toolExecutor: {
          async executeTool(call: ToolCallInput, _ctx: ToolExecutionContext) {
            calls.push(call.name);
            return { toolCallId: call.id, output: { ok: true } };
          },
        },
      }),
    );
    const events = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "spawn critic" }),
    );
    expect(calls).toEqual([]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "permission.denied",
          toolName: "spawn",
          toolCallId: "call-spawn",
        }),
        expect.objectContaining({ type: "turn.completed" }),
      ]),
    );
  });
});
