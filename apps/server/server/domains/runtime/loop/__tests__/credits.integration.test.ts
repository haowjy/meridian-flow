/** Runtime credit-gate integration tests for ledger exhaustion and interrupt meter-pause semantics. */

import { describe, expect, it } from "vitest";
import type { Gateway, GenerateResult, StreamEvent } from "../../gateway/index.js";
import {
  createToolExecutor,
  createToolRegistry,
  type InterruptToolHandlerContext,
  type ToolHandler,
} from "../../tools/index.js";
import { runtimeGate, runtimeScenario } from "./runtime-harness.js";
import { gatewayStubDefaults } from "./test-gateway.js";

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

async function setup(gateway: Gateway, creditsMillicredits = "1000000") {
  const registry = createToolRegistry();
  const rig = await runtimeScenario({
    gateway,
    creditsMillicredits,
    toolRegistry: registry,
    toolExecutor: createToolExecutor(registry),
  });
  return { ...rig, registry, interruptRegistry: rig.deps.interruptRegistry };
}

describe("runtime credits", () => {
  it("allows one turn at exact zero balance before blocking negative balances", async () => {
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "end", result: pricedTextResult() };
      },
      async generate() {
        throw new Error("not used");
      },
    };
    const { thread, creditLedger, orchestrator } = await setup(gateway, "200000");

    const completed = await (
      await orchestrator.prepare({ threadId: thread.id, userText: "first" })
    ).execute();
    expect(completed.status).toBe("complete");
    expect(await creditLedger.getBalance({ userId: "user-1" })).toBe("170000");

    const second = await (
      await orchestrator.prepare({ threadId: thread.id, userText: "second" })
    ).execute();
    expect(second.status).toBe("complete");
    expect(await creditLedger.getBalance({ userId: "user-1" })).toBe("-60000");

    await expect(
      orchestrator.prepare({ threadId: thread.id, userText: "third" }),
    ).rejects.toMatchObject({
      code: "credits_exhausted",
      retryable: false,
      source: "system",
    });
  });

  it("does not debit additional credits while parked on a interrupt", async () => {
    let call = 0;
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield {
            type: "end",
            result: {
              content: [
                { type: "tool_use", toolCallId: "cp-call", toolName: "ask_user", input: {} },
              ],
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
    const { thread, creditLedger, orchestrator, registry, interruptRegistry } =
      await setup(gateway);
    const parked = runtimeGate();
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "ask_user",
        description: "parks",
        inputSchema: { type: "object", properties: {} },
      },
      capability: "interrupt",
      execution: {
        type: "server",
        handler: (async (_input, ctx: InterruptToolHandlerContext) => {
          const answer = ctx.interrupt({
            interruptId: "cp-1",
            prompt: "pause",
            artifacts: [],
            answerSchema: { type: "object", properties: {} },
            requiresHuman: true,
          });
          parked.open();
          return answer;
        }) as ToolHandler<InterruptToolHandlerContext>,
      },
    });

    const handle = await orchestrator.prepare({ threadId: thread.id, userText: "park" });
    const eventsPromise = handle.execute();
    await parked.promise;
    expect(
      await creditLedger.getThreadDebitTotal({
        userId: "user-1",
        threadId: thread.id,
      }),
    ).toBe("230000");

    interruptRegistry.resolve({
      threadId: thread.id,
      turnId: handle.assistantTurnId,
      interruptId: "cp-1",
      value: {},
    });
    await eventsPromise;
    expect(await creditLedger.getThreadDebitTotal({ userId: "user-1", threadId: thread.id })).toBe(
      "460000",
    );
  });
});
