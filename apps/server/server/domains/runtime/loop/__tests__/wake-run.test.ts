import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { Gateway } from "../../gateway/index.js";
import type { MessageDraft } from "../ports.js";
import { runtimeScenario } from "./runtime-harness.js";
import { gatewayStubDefaults } from "./test-gateway.js";

const USER_ID = "user-1";

function textResult() {
  return {
    content: [{ type: "text" as const, text: "done" }],
    toolCalls: [],
    finishReason: "end_turn" as const,
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    model: "gpt-4.1-mini",
    provider: "openai",
  };
}

function textGateway(): Gateway {
  return {
    ...gatewayStubDefaults,
    async *stream() {
      yield { type: "end" as const, result: textResult() };
    },
    async generate() {
      throw new Error("not used");
    },
  };
}

function message(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "message",
    provenance: { kind: "writer", actorId: USER_ID },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

describe("wake run", () => {
  it("rereads after an empty run when a message arrives under its claim", async () => {
    const rig = await runtimeScenario({ gateway: textGateway() });
    const repair = rig.delivery.repairOrphanedTurns.bind(rig.delivery);
    let injected = false;
    rig.delivery.repairOrphanedTurns = async (lease) => {
      await repair(lease);
      if (injected) return;
      injected = true;
      await rig.inbox.enqueue(message("arrived during empty run", rig.thread.id));
    };

    await expect(rig.runner.startDrain(rig.thread.id)).resolves.toBeUndefined();
    await rig.untilSettled();

    expect(await rig.repos.turns.listByThread(rig.thread.id)).toHaveLength(2);
    expect(await rig.inbox.selectPending(rig.thread.id)).toEqual([]);
  });

  it("does not reread after a real setup error", async () => {
    const rig = await runtimeScenario({ gateway: textGateway() });
    const messageRow = await rig.inbox.enqueue(message("wait for recovery", rig.thread.id));
    const startExecution = rig.runClaim.startExecution.bind(rig.runClaim);
    let starts = 0;
    rig.runClaim.startExecution = async (...args) => {
      starts += 1;
      return startExecution(...args);
    };
    rig.delivery.repairOrphanedTurns = async () => {
      throw new Error("orphan repair unavailable");
    };

    await expect(rig.runner.startDrain(rig.thread.id)).rejects.toThrow("orphan repair unavailable");

    expect(starts).toBe(1);
    expect(await rig.inbox.selectPending(rig.thread.id)).toMatchObject([{ id: messageRow.id }]);
    expect(await rig.runClaim.holder(rig.thread.id)).toBeNull();
  });
});
