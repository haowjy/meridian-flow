/** Consolidated test contracts; each block retains its original fixture scope. */

import type { ThreadId } from "@meridian/contracts/runtime";
import { describe as __mergedSuite, afterAll, beforeAll, expect, it } from "vitest";
import { createThreadWebSocketSession, type WsPeer } from "../../../../lib/ws-thread-handler.js";
import { createInMemoryWorkRepository } from "../../../projects/adapters/work-repository/in-memory.js";
import { deleteWorkTransition } from "../../../projects/index.js";
import {
  createMockOpenAICompatibleServer,
  type MockOpenAIServer,
} from "../../gateway/adapters/mock/server.js";
import { createGateway } from "../../gateway/create-gateway.js";
import type { Gateway, StreamEvent } from "../../gateway/index.js";
import type { MessageDraft } from "../ports.js";
import { type RuntimeHarness, runtimeGate, runtimeScenario } from "./runtime-harness.js";
import { gatewayStubDefaults } from "./test-gateway.js";

__mergedSuite("interrupt-cancel.integration.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/__tests__/interrupt-cancel.integration.test.ts.
  const USER_ID = "user-1";

  function textResult() {
    return {
      content: [{ type: "text" as const, text: "done" }],
      toolCalls: [],
      finishReason: "end_turn" as const,
      usage: { inputTokens: 1000000, outputTokens: 1000000 },
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

  async function startMessageRun(rig: RuntimeHarness, text: string): Promise<string> {
    await rig.inbox.enqueue(message(text, rig.thread.id));
    await rig.runner.startDrain(rig.thread.id);
    await rig.gatewaySignal.promise;
    const turnId = await rig.runClaim.readRunningTurnId(rig.thread.id);
    if (!turnId) throw new Error("Expected a running assistant turn after drain start");
    return turnId;
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

  __mergedSuite("interrupt cancel", () => {
    it("sets the durable lease flag and publishes it through liveState", async () => {
      const control = gatedPartialGateway();
      const rig = await runtimeScenario({ gateway: control.gateway });
      const app = rig.createAppServices();
      const assistantTurnId = await startMessageRun(rig, "long turn");
      const before = await app.threadRuntime.liveState(rig.thread.id, rig.userId);
      expect(before.status).toEqual({
        kind: "awake",
        phase: "generating",
        cancelRequested: false,
      });
      const status = await app.runner.cancel(rig.thread.id, assistantTurnId);
      expect(status).toBe("cancelled");
      const during = await app.threadRuntime.liveState(rig.thread.id, rig.userId);
      expect(during.status).toMatchObject({ kind: "awake", cancelRequested: true });
      control.release();
      await rig.untilSettled();
    });
    it("finalizes cancellation and retires the adopted triggering message", async () => {
      const control = gatedPartialGateway();
      const rig = await runtimeScenario({ gateway: control.gateway });
      const turnId = await startMessageRun(rig, "no pending");
      await rig.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
      control.release();
      await rig.untilSettled();
      expect(await rig.turn(turnId as string)).toMatchObject({ status: "cancelled" });
      // Cancellation schedules a separate empty drain after this run settles.
      await expect.poll(() => rig.runClaim.read(rig.thread.id)).toEqual({ kind: "asleep" });
      const turns = await rig.repos.turns.listByThread(rig.thread.id);
      expect(turns).toHaveLength(2);
      expect(turns.filter((turn) => turn.role === "assistant").map((turn) => turn.status)).toEqual([
        "cancelled",
      ]);
      expect(await rig.inbox.selectPending(rig.thread.id)).toEqual([]);
    });
    it("finalizes a cancelled turn and starts a next turn carrying the pending message", async () => {
      const control = gatedPartialGateway();
      const rig = await runtimeScenario({ gateway: control.gateway });
      const turnId = await startMessageRun(rig, "interrupt me");
      const pending = await rig.inbox.enqueue(message("after interrupt", rig.thread.id));
      await rig.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
      control.release();
      await rig.untilSettled(2);
      const turns = await rig.repos.turns.listByThread(rig.thread.id);
      const cancelled = turns.find((turn) => turn.id === turnId);
      expect(cancelled?.status).toBe("cancelled");
      const messageTurn = turns.find((turn) => turn.id === pending.id);
      expect(messageTurn?.role).toBe("user");
      const successor = turns.find((turn) => turn.role === "assistant" && turn.id !== turnId);
      expect(successor?.prevTurnId).toBe(pending.id);
      expect(successor?.status).toBe("complete");
      expect(await rig.inbox.selectPending(rig.thread.id)).toEqual([]);
      expect(control.calls()).toBe(2);
    });
    it("carries the lease's running turn in the subscribed WS frame", async () => {
      const control = gatedPartialGateway();
      const rig = await runtimeScenario({ gateway: control.gateway });
      const app = rig.createAppServices();
      const turnId = await startMessageRun(rig, "subscribe liveness");
      type SubscribedFrame = {
        type?: string;
        state?: {
          runState?: {
            execution?: {
              currentTurnId?: string | null;
            } | null;
          };
          status?: {
            kind?: string;
          };
        };
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
      expect(subscribed?.state?.runState?.execution?.currentTurnId).toBe(turnId);
      expect(subscribed?.state?.status).toMatchObject({ kind: "awake" });
      await rig.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
      control.release();
      await rig.untilSettled();
    });
  });
});

__mergedSuite("cancel-billing.integration.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/__tests__/cancel-billing.integration.test.ts.
  function createMockGateway(mock: MockOpenAIServer): Gateway {
    return createGateway({
      providers: [
        {
          id: "openai",
          adapter: "openai-compatible",
          baseUrl: mock.baseUrl,
          models: [
            {
              id: "gpt-4.1-mini",
              provider: "openai",
              tokenizer: "o200k",
              displayName: "GPT-4.1 Mini",
              contextWindow: 128000,
              maxOutputTokens: 4096,
              promptCache: { kind: "none", ttlMs: null },
              capabilities: new Set(["streaming"]),
            },
          ],
        },
      ],
      defaultModel: "gpt-4.1-mini",
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
    });
  }

  __mergedSuite("cancel billing", () => {
    let mock: MockOpenAIServer;
    beforeAll(async () => {
      mock = await createMockOpenAICompatibleServer();
    });
    afterAll(async () => {
      await mock.close();
    });
    it("debits partial usage when cancelled mid-stream through createGateway", async () => {
      const rig = await runtimeScenario({ gateway: createMockGateway(mock) });
      const controller = new AbortController();
      const handle = await rig.orchestrator.prepare({
        threadId: rig.thread.id,
        userText: "cancel billing",
        signal: controller.signal,
      });
      const eventsPromise = rig.execute(handle);
      await rig.gatewaySignal.promise;
      controller.abort();
      const { events, outcome } = await eventsPromise;
      expect(outcome.status).toBe("cancelled");
      expect(events.some((event) => event.type === "model.response_received")).toBe(true);
      expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
      const balance = await rig.balance();
      expect(BigInt(balance)).toBeLessThan(1200000n);
      expect(balance).not.toBe("1200000");
    });
    it("does not cancel a running turn when a subscribed WebSocket disconnects", async () => {
      const rig = await runtimeScenario({ gateway: createMockGateway(mock) });
      const app = rig.createAppServices();
      await rig.inbox.enqueue({
        threadId: rig.thread.id,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.userId },
        body: { kind: "text", text: "cancel billing" },
        idempotencyKey: "cancel-billing-ws-disconnect",
      });
      await rig.runner.startDrain(rig.thread.id);
      await rig.gatewaySignal.promise;
      const turnId = await rig.runClaim.readRunningTurnId(rig.thread.id);
      expect(turnId).not.toBeNull();
      const peer: WsPeer = {
        request: new Request("https://app.localhost/ws-unrelated"),
        context: { app, userId: rig.userId, traceId: "test-ws-trace" },
        send: () => {},
        close: () => {},
      };
      const session = createThreadWebSocketSession(peer);
      session.open();
      await session.onMessage(
        JSON.stringify({ type: "subscribe", threadId: rig.thread.id, lastSeq: "0" }),
      );
      session.onClose();
      expect(await rig.runClaim.readRunningTurnId(rig.thread.id)).toBe(turnId);
      await app.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
      expect(await rig.awaitCancelled(turnId as NonNullable<typeof turnId>)).toMatchObject({
        status: "cancelled",
      });
    });
    it("cancels an active chat run after its Work is deleted", async () => {
      const rig = await runtimeScenario({ gateway: createMockGateway(mock) });
      const memoryWorks = createInMemoryWorkRepository();
      const work = await memoryWorks.create({
        projectId: rig.project.id as never,
        name: "Active run",
      });
      const softDelete = memoryWorks.softDelete.bind(memoryWorks);
      const works = {
        ...memoryWorks,
        async softDelete(workId: Parameters<typeof memoryWorks.softDelete>[0]) {
          return { ...(await softDelete(workId)), threadIds: [rig.thread.id as never] };
        },
      };
      await rig.inbox.enqueue({
        threadId: rig.thread.id,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.userId },
        body: { kind: "text", text: "delete while running" },
        idempotencyKey: "work-delete-active-run",
      });
      await rig.startDrain(rig.thread.id);
      await rig.gatewaySignal.promise;
      const turnId = await rig.runClaim.readRunningTurnId(rig.thread.id);
      expect(turnId).not.toBeNull();
      await deleteWorkTransition(
        {
          works,
          async stopThreadRun(threadId) {
            const runningTurnId = await rig.runClaim.readRunningTurnId(threadId);
            if (runningTurnId) await rig.runner.cancel(threadId, runningTurnId);
          },
        },
        work.id,
      );
      await expect(rig.awaitCancelled(turnId as NonNullable<typeof turnId>)).resolves.toMatchObject(
        {
          status: "cancelled",
        },
      );
    });
  });
});
