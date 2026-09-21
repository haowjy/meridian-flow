/**
 * Interrupt integration: cancel travels on the durable lease so it is visible
 * cross-process, the interrupted turn finalizes as `cancelled` and releases, and
 * a pending message starts the next turn as its own drain run. The same lease is
 * the one liveness truth the WS `subscribed` frame carries.
 */
import { EventType } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createThreadWebSocketSession, type WsPeer } from "../../../../lib/ws-thread-handler.js";
import type { Gateway, StreamEvent } from "../../gateway/index.js";
import type { MessageDraft } from "../ports.js";
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

function message(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "message",
    provenance: { kind: "writer", actorId: USER_ID },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

/**
 * First stream yields a delta then blocks on a test-controlled gate, ignoring
 * abort, so the lease state is observable while the run is still live. Later
 * streams return a complete text result immediately.
 */
function gatedPartialGateway(): {
  gateway: Gateway;
  release(): void;
  calls(): number;
} {
  const hang = runtimeGate();
  let calls = 0;
  const gateway: Gateway = {
    ...gatewayStubDefaults,
    async *stream(): AsyncGenerator<StreamEvent> {
      calls += 1;
      if (calls === 1) {
        yield { type: "start", model: "gpt-4.1-mini", provider: "openai" };
        yield { type: "text.delta", text: "partial" };
        await hang.promise;
        return;
      }
      yield { type: "end", result: textResult() };
    },
    async generate() {
      throw new Error("not used");
    },
  };
  return { gateway, release: () => hang.open(), calls: () => calls };
}

describe("interrupt cancel", () => {
  it("sets the durable lease flag and publishes it through liveState", async () => {
    const control = gatedPartialGateway();
    const rig = await RuntimeTestRig.create({ gateway: control.gateway });
    const app = rig.createAppServices();

    const { assistantTurnId } = await rig.runner.startTurn({
      threadId: rig.thread.id,
      userText: "long turn",
    });
    await rig.gatewaySignal.promise;

    const before = await app.threadRuntime.liveState(rig.thread.id, rig.userId);
    expect(before.status).toEqual({ kind: "awake", phase: "generating", cancelRequested: false });

    const status = await app.runner.cancel(rig.thread.id, assistantTurnId);
    expect(status).toBe("cancelled");

    const during = await app.threadRuntime.liveState(rig.thread.id, rig.userId);
    expect(during.status).toMatchObject({ kind: "awake", cancelRequested: true });

    control.release();
    await rig.awaitEvent(EventType.RUN_FINISHED);
  });

  it("finalizes turn.cancelled and releases when nothing is pending", async () => {
    const control = gatedPartialGateway();
    const rig = await RuntimeTestRig.create({ gateway: control.gateway });

    await rig.runner.startTurn({ threadId: rig.thread.id, userText: "no pending" });
    await rig.gatewaySignal.promise;
    const turnId = await rig.runAuthority.readRunningTurnId(rig.thread.id);
    expect(turnId).not.toBeNull();

    await rig.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
    control.release();

    await expect
      .poll(() => rig.turn(turnId as NonNullable<typeof turnId>))
      .toMatchObject({
        status: "cancelled",
      });
    await expect.poll(() => rig.runAuthority.read(rig.thread.id)).toEqual({ kind: "asleep" });
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toHaveLength(2);
  });

  it("finalizes a cancelled turn and starts a next turn carrying the pending message", async () => {
    const control = gatedPartialGateway();
    const rig = await RuntimeTestRig.create({ gateway: control.gateway });

    await rig.runner.startTurn({ threadId: rig.thread.id, userText: "interrupt me" });
    await rig.gatewaySignal.promise;
    const turnId = await rig.runAuthority.readRunningTurnId(rig.thread.id);
    expect(turnId).not.toBeNull();
    const pending = await rig.inbox.enqueue(message("after interrupt", rig.thread.id));

    await rig.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
    control.release();

    await expect
      .poll(async () => {
        const turns = await rig.repos.turns.listByThread(rig.thread.id);
        return turns.filter((turn) => turn.role === "assistant").length;
      })
      .toBe(2);

    const turns = await rig.repos.turns.listByThread(rig.thread.id);
    const cancelled = turns.find((turn) => turn.id === turnId);
    expect(cancelled?.status).toBe("cancelled");

    const messageTurn = turns.find((turn) => turn.id === pending.id);
    expect(messageTurn?.role).toBe("user");

    const successor = turns.find((turn) => turn.role === "assistant" && turn.id !== turnId);
    expect(successor?.prevTurnId).toBe(pending.id);
    expect(successor?.status).toBe("complete");
    expect(await rig.inbox.claimPending(rig.thread.id)).toEqual([]);
    expect(control.calls()).toBe(2);
  });

  it("carries the lease's running turn in the subscribed WS frame", async () => {
    const control = gatedPartialGateway();
    const rig = await RuntimeTestRig.create({ gateway: control.gateway });
    const app = rig.createAppServices();

    await rig.runner.startTurn({ threadId: rig.thread.id, userText: "subscribe liveness" });
    await rig.gatewaySignal.promise;
    const turnId = await rig.runAuthority.readRunningTurnId(rig.thread.id);
    expect(turnId).not.toBeNull();

    type SubscribedFrame = {
      type?: string;
      state?: { runningTurnId?: string | null; status?: { kind?: string } };
    };
    const frames: SubscribedFrame[] = [];
    const peer: WsPeer = {
      request: new Request("https://app.localhost/ws-subscribe"),
      context: { app, userId: rig.userId, traceId: "test-ws-trace" },
      send: (data) => frames.push(JSON.parse(data) as SubscribedFrame),
      close: () => {},
    };
    const session = createThreadWebSocketSession(peer);
    session.open();
    await session.onMessage(
      JSON.stringify({ type: "subscribe", threadId: rig.thread.id, lastSeq: "0" }),
    );

    const subscribed = frames.find((frame) => frame.type === "subscribed");
    expect(subscribed?.state?.runningTurnId).toBe(turnId);
    expect(subscribed?.state?.status).toMatchObject({ kind: "awake" });

    await rig.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
    control.release();
    await rig.awaitEvent(EventType.RUN_FINISHED);
  });
});
