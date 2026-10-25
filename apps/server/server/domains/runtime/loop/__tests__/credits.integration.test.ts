/** Runtime credit-gate integration test for ledger exhaustion.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Pending usage projection and debt gate
 */

import { describe, expect, it } from "vitest";
import type { Gateway, GenerateResult, StreamEvent } from "../../gateway/index.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import { runtimeScenario } from "./runtime-harness.js";
import { gatewayStubDefaults, scriptedGateway } from "./test-gateway.js";

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
  return { ...rig, registry };
}

describe("runtime credits", () => {
  it("records a drain's credit refusal without creating a reply, then clears it on start", async () => {
    let allowed = false;
    const rig = await runtimeScenario({
      gateway: scriptedGateway(),
      billingUsage: {
        async canStartTurn() {
          return allowed;
        },
        async canContinueModelCall() {
          return true;
        },
        async debit() {
          return { transactionId: "debit" };
        },
      },
    });
    const row = await rig.inbox.enqueue({
      threadId: rig.thread.id,
      intent: "message",
      provenance: { kind: "writer", actorId: "user-1" },
      body: { kind: "text", text: "kept" },
      idempotencyKey: "kept",
    });
    await expect(
      rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true }),
    ).rejects.toMatchObject({ code: "credits_exhausted" });
    expect((await rig.delivery.readPendingProjection(rig.thread.id)).blocked).toEqual({
      reason: "credits_exhausted",
    });
    expect(
      (await rig.repos.turns.listByThread(rig.thread.id)).filter(
        (turn) => turn.role === "assistant",
      ),
    ).toHaveLength(0);
    allowed = true;
    const run = await rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true });
    expect((await rig.delivery.readPendingProjection(rig.thread.id)).blocked).toBeUndefined();
    expect((await rig.delivery.selectPending(rig.thread.id)).map((item) => item.id)).toContain(
      row.id,
    );
    await run.execute();
  });
  it("clears a withdrawn usage block and refuses to block an empty inbox in memory", async () => {
    const rig = await runtimeScenario({
      gateway: scriptedGateway(),
      billingUsage: {
        async canStartTurn() {
          return false;
        },
        async canContinueModelCall() {
          return true;
        },
        async debit() {
          return { transactionId: "debit" };
        },
      },
    });
    await rig.repos.turns.create({
      threadId: rig.thread.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const row = await rig.delivery.enqueue({
      threadId: rig.thread.id,
      intent: "control",
      provenance: { kind: "writer", actorId: "user-1" },
      body: { kind: "compact" },
      idempotencyKey: "withdraw",
    });
    await expect(
      rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true }),
    ).rejects.toMatchObject({ code: "credits_exhausted" });
    expect((await rig.delivery.readPendingProjection(rig.thread.id)).blocked).toBeDefined();
    await rig.delivery.withdrawControl(rig.thread.id, row.id);
    expect((await rig.delivery.readPendingProjection(rig.thread.id)).blocked).toBeUndefined();
    await rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true }).catch(() => undefined);
    expect((await rig.delivery.readPendingProjection(rig.thread.id)).blocked).toBeUndefined();
    await rig.delivery.enqueue({
      threadId: rig.thread.id,
      intent: "message",
      provenance: { kind: "writer", actorId: "user-1" },
      body: { kind: "text", text: "new work" },
      idempotencyKey: "new",
    });
    expect((await rig.delivery.readPendingProjection(rig.thread.id)).blocked).toBeUndefined();
  });
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
