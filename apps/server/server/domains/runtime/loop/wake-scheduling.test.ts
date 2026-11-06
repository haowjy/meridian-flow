/** Consolidated test contracts; each block retains its original fixture scope.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Bounded wake and recovery scheduling
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import { describe as __mergedSuite, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryInbox, createInMemoryRunClaim } from "../adapters/in-memory/loop-ports.js";
import type { Gateway } from "../gateway/index.js";
import { runtimeScenario } from "./__tests__/runtime-harness.js";
import { gatewayStubDefaults } from "./__tests__/test-gateway.js";
import type { MessageDraft } from "./ports.js";
import { sweepWakes } from "./sweep-wakes.js";
import { createWakeIfRunnable } from "./wake-if-runnable.js";

__mergedSuite("wake-run.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/__tests__/wake-run.test.ts.
  const USER_ID = "user-1";

  function textResult() {
    return {
      content: [{ type: "text" as const, text: "done" }],
      toolCalls: [],
      finishReason: "end_turn" as const,
      usage: { inputTokens: 1000000, outputTokens: 1000000 },
      model: "gpt-5.6-luna",
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

  __mergedSuite("wake run", () => {
    it("rereads after an empty run when a message arrives under its claim", async () => {
      const rig = await runtimeScenario({ gateway: textGateway() });
      const settle = rig.delivery.settleStaleExecution.bind(rig.delivery);
      let injected = false;
      rig.delivery.settleStaleExecution = async (threadId) => {
        await settle(threadId);
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
      rig.delivery.settleStaleExecution = async () => {
        throw new Error("orphan repair unavailable");
      };
      await expect(rig.runner.startDrain(rig.thread.id)).rejects.toThrow(
        "orphan repair unavailable",
      );
      expect(starts).toBe(1);
      expect(await rig.inbox.selectPending(rig.thread.id)).toMatchObject([{ id: messageRow.id }]);
      expect(await rig.runClaim.holder(rig.thread.id)).toBeNull();
    });
  });
});

__mergedSuite("wake-if-runnable.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/wake-if-runnable.test.ts.
  __mergedSuite("wakeIfRunnable", () => {
    it("does not start if shutdown begins while the queue is read", async () => {
      const shutdown = { started: false };
      const inbox = createInMemoryInbox();
      await inbox.enqueue({
        threadId: "thread" as ThreadId,
        intent: "message",
        provenance: { kind: "writer", actorId: "user-1" },
        body: { kind: "text", text: "hi" },
        idempotencyKey: "k",
      });
      const selectPending = vi.fn(async (id: ThreadId) => {
        shutdown.started = true;
        return inbox.selectPending(id);
      });
      const start = vi.fn();
      const wake = createWakeIfRunnable({
        shutdown,
        delivery: { selectPending },
        runStarter: { start },
      });
      await wake("thread" as ThreadId);
      expect(start).not.toHaveBeenCalled();
    });
  });
});

__mergedSuite("sweep-wakes.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/sweep-wakes.test.ts.
  const THREAD_A = "thread-a" as ThreadId;

  const THREAD_B = "thread-b" as ThreadId;

  const USER_ID = "user-1";

  function message(key: string, threadId: ThreadId): MessageDraft {
    return {
      threadId,
      intent: "message",
      provenance: { kind: "writer", actorId: USER_ID },
      body: { kind: "text", text: key },
      idempotencyKey: key,
    };
  }

  __mergedSuite("sweepWakes", () => {
    it("pages past poisoned candidates and wraps to retry them", async () => {
      const inbox = createInMemoryInbox();
      const authority = createInMemoryRunClaim();
      await inbox.enqueue(message("a", THREAD_A));
      await inbox.enqueue(message("b", THREAD_B));
      const started: ThreadId[] = [];
      let afterThreadId: ThreadId | undefined;
      for (let i = 0; i < 3; i++) {
        ({ cursor: afterThreadId } = await sweepWakes({
          eventSink: createInMemoryEventSink(),
          delivery: inbox,
          authority,
          limit: 1,
          afterThreadId,
          runStarter: {
            async start(id) {
              started.push(id);
              if (id === THREAD_A) throw new Error("exhausted balance");
            },
          },
        }));
      }
      expect(started).toEqual([THREAD_A, THREAD_B, THREAD_A]);
    });
  });
});
