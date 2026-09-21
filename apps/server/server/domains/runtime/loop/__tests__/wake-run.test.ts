/**
 * End-to-end wake: `RunStarter.start` on an asleep thread with a pending steer
 * claims the lease, drains the steer as the run's first user turn, and releases.
 * A second start while that run is live is swallowed and adds no turn.
 */
import { EventType } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { Gateway } from "../../gateway/index.js";
import type { MessageDraft } from "../ports.js";
import { createRunStarter } from "../run-starter.js";
import { RuntimeTestRig, runtimeGate } from "./runtime-test-rig.js";
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

function gatedGateway(gate: ReturnType<typeof runtimeGate>): Gateway {
  return {
    ...gatewayStubDefaults,
    async *stream() {
      await gate.promise;
      yield { type: "end" as const, result: textResult() };
    },
    async generate() {
      throw new Error("not used");
    },
  };
}

function steer(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "steer",
    provenance: { kind: "writer", actorId: USER_ID },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

describe("wake run", () => {
  it("starts and drains a run for a steer on an asleep thread", async () => {
    const rig = await RuntimeTestRig.create({ gateway: textGateway() });
    await rig.inbox.enqueue(steer("wake me", rig.thread.id));

    await createRunStarter(rig.runner).start(rig.thread.id);
    await rig.awaitEvent(EventType.RUN_FINISHED);

    const turns = await rig.repos.turns.listByThread(rig.thread.id);
    const steerTurn = turns.find(
      (turn) =>
        turn.role === "user" && (turn.metadata as { kind?: string } | null)?.kind === "steer",
    );
    const assistantTurn = turns.find((turn) => turn.role === "assistant");
    expect(steerTurn).toBeDefined();
    expect(assistantTurn?.prevTurnId).toBe(steerTurn?.id);
    expect(await rig.inbox.claimPending(rig.thread.id)).toEqual([]);
  });

  it("swallows a second start while a run is live without adding a turn", async () => {
    const gate = runtimeGate();
    const rig = await RuntimeTestRig.create({ gateway: gatedGateway(gate) });
    await rig.inbox.enqueue(steer("wake me", rig.thread.id));
    const runStarter = createRunStarter(rig.runner);

    await runStarter.start(rig.thread.id);
    // The run is live but blocked in its provider stream; the wake is a no-op.
    await expect(runStarter.start(rig.thread.id)).resolves.toBeUndefined();
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toHaveLength(2);

    gate.open();
    await rig.awaitEvent(EventType.RUN_FINISHED);
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toHaveLength(2);
  });

  it("swallows a wake with no pending steer and releases the acquired lease", async () => {
    const rig = await RuntimeTestRig.create({ gateway: textGateway() });

    await expect(rig.runner.startDrain(rig.thread.id)).resolves.toBeUndefined();
    expect(await rig.runAuthority.holder(rig.thread.id)).toBeNull();
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toEqual([]);
  });
});
