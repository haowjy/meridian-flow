import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../../observability/index.js";
import type { Gateway } from "../../gateway/index.js";
import type { MessageDraft } from "../ports.js";
import { createRunStarter } from "../run-starter.js";
import { runtimeGate, runtimeScenario } from "./runtime-harness.js";
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

function gatedGateway(gate: ReturnType<typeof runtimeGate<void>>): Gateway {
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
  it("starts and drains a run for a message on an asleep thread", async () => {
    const rig = await runtimeScenario({ gateway: textGateway() });
    const queued = await rig.inbox.enqueue(message("wake me", rig.thread.id));

    await createRunStarter(rig.runner, createInMemoryEventSink()).start(rig.thread.id);
    await rig.untilSettled();

    const turns = await rig.repos.turns.listByThread(rig.thread.id);
    const messageTurn = turns.find((turn) => turn.id === queued.id);
    const assistantTurn = turns.find((turn) => turn.role === "assistant");
    expect(messageTurn).toBeDefined();
    expect(assistantTurn?.prevTurnId).toBe(messageTurn?.id);
    expect(await rig.inbox.selectPending(rig.thread.id)).toEqual([]);
  });

  it("swallows a second start while a run is live without adding a turn", async () => {
    const gate = runtimeGate();
    const rig = await runtimeScenario({ gateway: gatedGateway(gate) });
    await rig.inbox.enqueue(message("wake me", rig.thread.id));
    const runStarter = createRunStarter(rig.runner, createInMemoryEventSink());

    await runStarter.start(rig.thread.id);
    // The run is live but blocked in its provider stream; the wake is a no-op.
    await expect(runStarter.start(rig.thread.id)).resolves.toBeUndefined();
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toHaveLength(2);

    gate.open();
    await rig.untilSettled();
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toHaveLength(2);
  });

  it("swallows a wake with no pending message and releases the acquired lease", async () => {
    const rig = await runtimeScenario({ gateway: textGateway() });

    await expect(rig.runner.startDrain(rig.thread.id)).resolves.toBeUndefined();
    expect(await rig.runClaim.holder(rig.thread.id)).toBeNull();
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toEqual([]);
  });

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

  it("notifies on run start while the run is live", async () => {
    const gate = runtimeGate();
    const started: ThreadId[] = [];
    const rig = await runtimeScenario({
      gateway: gatedGateway(gate),
      onRunStarted: (threadId) => started.push(threadId),
    });
    await rig.inbox.enqueue(message("wake me", rig.thread.id));

    await createRunStarter(rig.runner, createInMemoryEventSink()).start(rig.thread.id);
    // The run is live and blocked in its provider stream; the start notify has
    // already fired, so a woken subagent strip can read `awake` before terminal.
    expect(started).toEqual([rig.thread.id]);
    expect(await rig.runClaim.read(rig.thread.id)).toMatchObject({ kind: "awake" });

    gate.open();
    await rig.untilSettled();
    expect(await rig.runClaim.read(rig.thread.id)).toEqual({ kind: "asleep" });
  });

  it("derives awake while a run streams and asleep once it releases", async () => {
    const gate = runtimeGate();
    const rig = await runtimeScenario({ gateway: gatedGateway(gate) });
    await rig.inbox.enqueue(message("status", rig.thread.id));

    await createRunStarter(rig.runner, createInMemoryEventSink()).start(rig.thread.id);
    // The run owns a live lease and is blocked in its provider stream.
    expect(await rig.runClaim.read(rig.thread.id)).toEqual({
      kind: "awake",
      phase: "generating",
      cancelRequested: false,
    });

    gate.open();
    await rig.untilSettled();
    // Release trails the terminal event; status is a pure function of the lease.
    expect(await rig.runClaim.read(rig.thread.id)).toEqual({ kind: "asleep" });
  });
});
