/** Runtime credit-gate integration test for ledger exhaustion. */

import { describe, expect, it } from "vitest";
import type { Gateway, GenerateResult, StreamEvent } from "../../gateway/index.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import { runtimeScenario } from "./runtime-harness.js";
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
});
