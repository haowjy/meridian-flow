/**
 * End-to-end wake: `RunStarter.start` on an asleep thread with a pending message
 * claims the lease, drains the message as the run's first user turn, and releases.
 * A second start while that run is live is swallowed and adds no turn.
 */
import { EventType } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../../observability/index.js";
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
    const rig = await RuntimeTestRig.create({ gateway: textGateway() });
    await rig.inbox.enqueue(message("wake me", rig.thread.id));

    await createRunStarter(rig.runner, createInMemoryEventSink()).start(rig.thread.id);
    await rig.awaitEvent(EventType.RUN_FINISHED);

    const turns = await rig.repos.turns.listByThread(rig.thread.id);
    const messageTurn = turns.find(
      (turn) =>
        turn.role === "user" && (turn.metadata as { kind?: string } | null)?.kind === "message",
    );
    const assistantTurn = turns.find((turn) => turn.role === "assistant");
    expect(messageTurn).toBeDefined();
    expect(assistantTurn?.prevTurnId).toBe(messageTurn?.id);
    expect(await rig.inbox.selectPending(rig.thread.id)).toEqual([]);
  });

  it("swallows a second start while a run is live without adding a turn", async () => {
    const gate = runtimeGate();
    const rig = await RuntimeTestRig.create({ gateway: gatedGateway(gate) });
    await rig.inbox.enqueue(message("wake me", rig.thread.id));
    const runStarter = createRunStarter(rig.runner, createInMemoryEventSink());

    await runStarter.start(rig.thread.id);
    // The run is live but blocked in its provider stream; the wake is a no-op.
    await expect(runStarter.start(rig.thread.id)).resolves.toBeUndefined();
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toHaveLength(2);

    gate.open();
    await rig.awaitEvent(EventType.RUN_FINISHED);
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toHaveLength(2);
  });

  it("swallows a wake with no pending message and releases the acquired lease", async () => {
    const rig = await RuntimeTestRig.create({ gateway: textGateway() });

    await expect(rig.runner.startDrain(rig.thread.id)).resolves.toBeUndefined();
    expect(await rig.runClaim.holder(rig.thread.id)).toBeNull();
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toEqual([]);
  });

  it("notifies on run start while the run is live", async () => {
    const gate = runtimeGate();
    const started: ThreadId[] = [];
    const rig = await RuntimeTestRig.create({
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
    await rig.awaitEvent(EventType.RUN_FINISHED);
    await expect.poll(() => rig.runClaim.read(rig.thread.id)).toEqual({ kind: "asleep" });
  });

  it("derives awake while a run streams and asleep once it releases", async () => {
    const gate = runtimeGate();
    const rig = await RuntimeTestRig.create({ gateway: gatedGateway(gate) });
    await rig.inbox.enqueue(message("status", rig.thread.id));

    await createRunStarter(rig.runner, createInMemoryEventSink()).start(rig.thread.id);
    // The run owns a live lease and is blocked in its provider stream.
    expect(await rig.runClaim.read(rig.thread.id)).toEqual({
      kind: "awake",
      phase: "generating",
      cancelRequested: false,
    });

    gate.open();
    await rig.awaitEvent(EventType.RUN_FINISHED);
    // Release trails the terminal event; status is a pure function of the lease.
    await expect.poll(() => rig.runClaim.read(rig.thread.id)).toEqual({ kind: "asleep" });
  });
});
