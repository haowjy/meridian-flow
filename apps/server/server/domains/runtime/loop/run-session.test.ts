/** Run admission is lazy; one owner settles cancellation, crashes, and cleanup.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Run lease, publication, and descendant-lifetime protocol
 */

import type { TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import {
  classifyHistoryItem,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import { createRuntimeHarness } from "./__tests__/runtime-harness.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { DEFAULT_LEASE_TTL_MS } from "./ports.js";
import { sweepWakes } from "./sweep-wakes.js";

async function fixture(configure?: (deps: OrchestratorDeps) => void) {
  const repos = createInMemoryRepositories();
  const journal = createInMemoryEventJournalWriter(repos.transactionOwner);
  const sink = createInMemoryEventSink();
  let calls = 0;
  const requests: string[] = [];
  const thread = await repos.threads.create({
    aiWriteMode: "direct",
    userId: "user-1",
    projectId: "project-1",
  });
  const boundThreadIds = new Set([thread.id]);
  const harness = createRuntimeHarness({
    repos,
    eventWriter: journal,
    eventSink: sink,
    headSeq: (id) => journal.headSeq(id),
    boundThreads: () => [...boundThreadIds],
  });
  const deps = harness.deps;

  await deps.creditLedger.grant({
    userId: thread.userId,
    source: "manual",
    amountMillicredits: "1000000",
    reason: "session",
  });
  deps.gateway = {
    ...deps.gateway,
    async *stream(request) {
      calls++;
      requests.push(JSON.stringify(request.messages));
      yield {
        type: "end",
        result: {
          content: [{ type: "text", text: "done" }],
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "gpt-4.1-mini",
          provider: "openai",
        },
      };
    },
  };
  configure?.(deps);
  const runtime = harness.orchestrator;
  return {
    runtime,
    repos,
    deps,
    backgroundTasks: harness.backgroundTasks,
    thread,
    boundThreadIds,
    journal,
    sink,
    calls: () => calls,
    requests,
    prepare: () => runtime.prepare({ threadId: thread.id, userText: "hello" }),
  };
}

describe("RunSession", () => {
  it("aborts and settles live replies on shutdown, then refuses new starts", async () => {
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    let streams = 0;
    const f = await fixture((deps) => {
      deps.gateway.stream = async function* (request) {
        streams++;
        providerSignal = request.signal;
        providerStarted();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "partial answer" }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        };
      };
      deps.gateway.settleCancelledResult = async ({ result }) =>
        result ? { result, persist: true } : null;
    });

    const balanceBefore = await f.deps.creditLedger.getBalance({ userId: f.thread.userId });
    const run = await f.prepare();
    const execution = run.execute();
    await started;
    f.runtime.beginShutdown();

    await expect(execution).resolves.toMatchObject({
      status: "error",
      turn: { status: "error", error: "This response failed.", metadata: { reason: "shutdown" } },
    });
    expect(providerSignal?.reason).toBe("shutdown");
    expect(await f.repos.modelResponses.listByTurn(run.executionTurnId)).toHaveLength(1);
    expect(BigInt(await f.deps.creditLedger.getBalance({ userId: f.thread.userId }))).toBeLessThan(
      BigInt(balanceBefore),
    );

    await f.runtime.startDrain(f.thread.id);
    await expect(
      f.runtime.prepare({ threadId: f.thread.id, userText: "after shutdown" }),
    ).rejects.toMatchObject({ name: "RuntimeShuttingDownError" });
    expect(streams).toBe(1);
  });

  it("finalizes fork-context prep failure on the adopted message without a wake retry", async () => {
    const f = await fixture();
    const message = await f.deps.delivery.enqueue({
      threadId: f.thread.id,
      intent: "message",
      provenance: { kind: "writer", actorId: f.thread.userId },
      body: { kind: "text", text: "Keep writing" },
      idempotencyKey: "context-failure",
    });
    const findById = f.repos.threads.findById;
    f.repos.threads.findById = async (threadId) => {
      const thread = await findById(threadId);
      return thread?.id === f.thread.id
        ? { ...thread, originType: "fork", originTurnId: "missing-cutoff" as TurnId }
        : thread;
    };

    const run = await f.runtime.prepare({ threadId: f.thread.id, drain: true });
    expect(await f.repos.turns.findById(message.id as TurnId)).toMatchObject({
      id: message.id,
      role: "user",
      origin: "writer",
    });
    expect(await f.deps.runClaim.holder(f.thread.id)).toBe(run.executionId);

    expect(await run.execute()).toMatchObject({ status: "error", turn: { status: "error" } });
    expect(await f.repos.turns.findById(run.executionTurnId)).toMatchObject({
      status: "error",
      error: "This response failed.",
      metadata: { reason: "missing_cutoff_turn" },
    });
    const terminal = f.journal
      .getEvents(f.thread.id)
      .map(({ event }) => event)
      .find((event) => event.type === "turn.error");
    expect(terminal).toMatchObject({
      type: "turn.error",
      error: {
        code: "runtime_error",
        message: expect.stringMatching(/has no cutoff turn$/),
        source: "system",
        retryable: false,
        details: { reason: "missing_cutoff_turn" },
      },
    });
    expect(f.sink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        source: "runtime.orchestrator",
        name: "thread.conversation_context.load_failed",
        correlation: { threadId: f.thread.id },
        payload: {
          threadId: f.thread.id,
          cutoffTurnId: "missing-cutoff",
          errorCode: "missing_cutoff_turn",
        },
      }),
    );
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
    expect(await f.deps.delivery.selectPending(f.thread.id)).toEqual([]);
    expect(await f.deps.delivery.pendingMessageThreads(10)).toEqual([]);

    const start = vi.fn(async () => {});
    await sweepWakes({
      delivery: f.deps.delivery,
      authority: f.deps.runClaim,
      runStarter: { start },
      eventSink: f.deps.eventSink,
      limit: 10,
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("abandons, leaving its row open, an execution whose terminal fallback failed; the next start settles it", async () => {
    const f = await fixture();
    const run = await f.prepare();
    const listBlocks = f.deps.repos.blocks.listByThread;
    const transaction = f.deps.repos.transaction;
    f.deps.repos.blocks.listByThread = async () => {
      throw new Error("history unavailable");
    };
    f.deps.repos.transaction = async () => {
      throw new Error("database offline");
    };
    expect(await run.execute()).toMatchObject({ status: "failed" });
    expect(f.sink.events.map((event) => event.name)).toEqual([
      "execution.failed",
      "terminal_fallback.failed",
    ]);
    // The release's wake is detached; with no switch step ahead of it, it races this read.
    await f.backgroundTasks.drain();
    expect(f.runtime.getRunningTurn(f.thread.id)).toBeNull();
    // Unlocked and asleep, but the execution is still open: its turn never went terminal.
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
    const abandoned = await f.deps.runClaim.readOpenExecutionId(f.thread.id);
    expect(abandoned).toEqual(expect.any(String));

    f.deps.repos.blocks.listByThread = listBlocks;
    f.deps.repos.transaction = transaction;
    await (await f.prepare()).execute();
    expect(await f.repos.turns.findById(run.executionTurnId)).toMatchObject({ status: "error" });
    expect(await f.deps.runClaim.readOpenExecutionId(f.thread.id)).toBeNull();
    // The failed turn's `turn.error` copy is the writer's, never the model's.
    const failed = await f.repos.turns.findById(run.executionTurnId);
    expect(failed?.error).toEqual(expect.any(String));
    expect(f.requests.length).toBeGreaterThan(0);
    for (const request of f.requests) expect(request).not.toContain(failed?.error as string);
  });

  it("terminalizes admitted setup when post-setup cursor capture fails", async () => {
    let reads = 0;
    const f = await fixture((deps) => {
      deps.headSeq = async () => {
        if (++reads === 2) throw new Error("cursor unavailable");
        return 0n;
      };
    });
    await expect(f.prepare()).rejects.toThrow("cursor unavailable");
    const turns = await f.deps.repos.turns.listByThread(f.thread.id);
    expect(turns.find((turn) => turn.role === "assistant")?.status).toBe("error");
    expect(f.calls()).toBe(0);
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
  });

  it("retries physical release after terminal release fails", async () => {
    let releases = 0;
    const f = await fixture((deps) => {
      const release = deps.runClaim.release;
      deps.runClaim.release = async (lease) => {
        if (++releases === 1) throw new Error("physical unlock failed");
        return release(lease);
      };
    });
    const run = await f.prepare();
    await run.execute();
    expect(releases).toBeGreaterThanOrEqual(2);
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
    expect(f.runtime.isThreadRunning(f.thread.id)).toBe(false);
  });

  it("heartbeats a lazy prepared run, observes renewal failure, and stops on release", async () => {
    vi.useFakeTimers();
    try {
      const renew = vi.fn(async () => {
        throw new Error("renew offline");
      });
      const f = await fixture((deps) => {
        deps.runClaim.renew = renew;
      });
      const run = await f.prepare();
      await vi.advanceTimersByTimeAsync(Math.floor(DEFAULT_LEASE_TTL_MS / 3));
      expect(f.sink.events.map((event) => event.name)).toContain("lease_renew.failed");
      await run.execute();
      const calls = renew.mock.calls.length;
      await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_TTL_MS);
      expect(renew).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    true,
  ])("commits child admission and releases before publication B (card failure: %s)", async (failCard) => {
    const f = await fixture();
    const { createChildRunDriver } = await import("../spawn/child-run-driver.js");
    const { createDefaultTreeBudget } = await import("@meridian/contracts/spawn");
    const parentTurn = await f.deps.repos.turns.create({
      threadId: f.thread.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
      prevTurnId: null,
    });
    const child = await f.repos.threads.createSubagent({
      aiWriteMode: "direct",
      userId: f.thread.userId,
      projectId: f.thread.projectId,
      parentThreadId: f.thread.id,
      rootThreadId: f.thread.id,
      originTurnId: parentTurn.id,
      spawnDepth: 1,
    });
    const readBinding = f.deps.agentRevisions.readThreadBinding;
    f.deps.agentRevisions.readThreadBinding = () => readBinding(f.thread.id);
    let published!: () => void;
    const publication = new Promise<void>((resolve) => {
      published = resolve;
    });
    const driver = createChildRunDriver({
      backgroundTasks: f.backgroundTasks,
      orchestrator: f.runtime,
      repos: f.deps.repos,
      eventWriter: f.journal,
      readActivity: async () => ({ children: [] }),
      eventSink: f.sink,
      publisher: {
        async publish(threadId, execution) {
          expect(await f.deps.runClaim.holder(threadId)).toBeNull();
          expect(f.runtime.getRunningTurn(threadId)).toBeNull();
          expect(
            await f.deps.repos.executionReports.findByExecution(threadId, execution),
          ).toMatchObject({ outcome: "succeeded" });
          published();
          return "published";
        },
      },
    });
    const prepared = await driver.register(child, "general", { background: true, origin: "spawn" });
    const execution = await driver.driveBackground(
      prepared,
      {
        parentThread: f.thread,
        parentTurnId: parentTurn.id,
        prompt: "child",
        budget: createDefaultTreeBudget(),
        reportCorrelation: {
          callerThreadId: f.thread.id,
          callerTurnId: parentTurn.id,
          toolCallId: "spawn",
          cardBlockId: null,
          origin: "spawn",
          deliveryMode: "background_notification",
        },
      },
      async (execution) => {
        expect(f.calls()).toBe(0);
        expect(
          await f.deps.repos.executionReports.findByExecution(child.id, execution),
        ).toMatchObject({ outcome: null });
        expect(await f.deps.repos.turns.findById(execution)).toMatchObject({ status: "streaming" });
        if (failCard) throw new Error("card binding unavailable");
      },
    );
    expect(execution).toBeTruthy();
    await publication;
    expect(
      f.sink.events.filter((event) => event.name === "child.admission_callback_failed"),
    ).toHaveLength(failCard ? 1 : 0);
  });

  it.each([
    true,
  ])("preserves descendant lifetime at parent completion (child parent: %s)", async (childParent) => {
    const f = await fixture();
    const fg = await f.deps.repos.threads.create({
      aiWriteMode: "direct",
      userId: f.thread.userId,
      projectId: f.thread.projectId,
    });
    const bg = await f.deps.repos.threads.create({
      aiWriteMode: "direct",
      userId: f.thread.userId,
      projectId: f.thread.projectId,
    });
    const readBinding = f.deps.agentRevisions.readThreadBinding;
    f.deps.agentRevisions.readThreadBinding = () => readBinding(f.thread.id);
    const parent = await f.runtime.prepare({
      threadId: f.thread.id,
      userText: "parent",
      ...(childParent
        ? {
            child: {
              parentThreadId: "ancestor",
              background: false,
              origin: "spawn" as const,
              sender: { ref: "c0", title: "Ancestor" },
            },
          }
        : {}),
    });
    const foreground = await f.runtime.prepare({
      threadId: fg.id,
      userText: "fg",
      child: {
        parentThreadId: f.thread.id,
        background: false,
        origin: "message",
        sender: { ref: "c1", title: "Parent" },
      },
    });
    const foregroundTurn = await f.repos.turns.findById(foreground.userTurnId);
    expect(foregroundTurn && classifyHistoryItem(foregroundTurn)).toEqual({
      kind: "agent_request",
      source: "foreground_message",
    });
    expect(foregroundTurn?.metadata).toMatchObject({
      sender: { threadId: f.thread.id, ref: "c1", title: "Parent" },
    });
    const background = await f.runtime.prepare({
      threadId: bg.id,
      userText: "bg",
      child: {
        parentThreadId: f.thread.id,
        background: true,
        origin: "spawn",
        sender: { ref: "c1", title: "Parent" },
      },
    });
    expect((await parent.execute()).status).toBe("complete");
    expect((await foreground.execute()).status).toBe("cancelled");
    expect((await background.execute()).status).toBe(childParent ? "cancelled" : "complete");
  });
  it("fallback terminalizes its own current turn, never another holder's turn", async () => {
    const f = await fixture();
    const run = await f.prepare();
    const other = await f.repos.turns.create({
      threadId: f.thread.id,
      role: "assistant",
      origin: "assistant",
      status: "streaming",
      prevTurnId: run.executionTurnId,
    });
    f.deps.runClaim.readRunningTurnId = async () => other.id;
    f.deps.repos.blocks.listByThread = async () => {
      throw new Error("history unavailable");
    };
    const outcome = await run.execute();
    expect(outcome).toMatchObject({ status: "error", turn: { id: run.executionTurnId } });
    expect((await f.repos.turns.findById(other.id))?.status).toBe("streaming");
  });

  it("preserves committed terminal truth when only the backstop release fails", async () => {
    let releases = 0;
    const f = await fixture((deps) => {
      const release = deps.runClaim.release;
      deps.runClaim.release = async (lease) => {
        if (++releases === 2) throw new Error("backstop unavailable");
        return release(lease);
      };
    });
    const run = await f.prepare();
    expect(await run.execute()).toMatchObject({
      status: "complete",
      turn: { id: run.executionTurnId },
    });
    expect(f.sink.events.map((event) => event.name)).toContain("lease_release.failed");
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
  });
});
