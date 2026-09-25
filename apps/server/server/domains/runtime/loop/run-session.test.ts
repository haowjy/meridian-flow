/** Run admission is lazy; one owner settles cancellation, crashes, and cleanup. */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import { createTestOrchestratorDeps } from "./__tests__/test-orchestrator-deps.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { DEFAULT_LEASE_TTL_MS } from "./ports.js";

async function fixture(configure?: (deps: OrchestratorDeps) => void) {
  const journal = createInMemoryEventJournalWriter();
  const sink = createInMemoryEventSink();
  let calls = 0;
  const repos = createInMemoryRepositories();
  const deps = createTestOrchestratorDeps({
    repos,
    eventWriter: journal,
    eventSink: sink,
    headSeq: (id) => journal.headSeq(id),
    boundThreads: () => [thread.id],
  });
  const thread = await deps.repos.threads.create({ userId: "user-1", projectId: "project-1" });
  await deps.creditLedger.grant({
    userId: thread.userId,
    source: "manual",
    amountMillicredits: "1000000",
    reason: "session",
  });
  deps.gateway = {
    ...deps.gateway,
    async *stream() {
      calls++;
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
  const runtime = createOrchestrator(deps);
  return {
    runtime,
    repos,
    deps,
    thread,
    journal,
    sink,
    calls: () => calls,
    prepare: () => runtime.prepare({ threadId: thread.id, userText: "hello" }),
  };
}

describe("RunSession", () => {
  it("commits setup and captures the cursor before one-shot execution", async () => {
    const f = await fixture();
    const run = await f.prepare();
    expect(f.calls()).toBe(0);
    expect(run.resumeAfterSeq).toBe("0");
    expect(BigInt(run.snapshotFloorNextSeq)).toBe((await f.journal.headSeq(f.thread.id)) + 1n);
    expect(await f.deps.repos.turns.findById(run.assistantTurnId)).toMatchObject({
      status: "streaming",
    });
    expect(await f.deps.runClaim.holder(f.thread.id)).toBe(run.runId);
    const execution = run.execute();
    expect(run.execute()).toBe(execution);
    expect(await execution).toMatchObject({
      status: "complete",
      turn: { id: run.assistantTurnId },
    });
    expect(f.calls()).toBe(1);
    expect(f.journal.getEvents(f.thread.id).map(({ event }) => event.type)).toContain(
      "turn.completed",
    );
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
    expect(f.runtime.isThreadRunning(f.thread.id)).toBe(false);
  });

  it("cancels a prepared run without invoking the model", async () => {
    const f = await fixture();
    const run = await f.prepare();
    expect(await f.runtime.cancel(f.thread.id, run.assistantTurnId)).toBe("cancelled");
    expect(await run.execute()).toMatchObject({ status: "cancelled" });
    expect(f.calls()).toBe(0);
    await expect.poll(() => f.runtime.isThreadRunning(f.thread.id)).toBe(false);
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
  });

  it("falls back after a pre-loop crash and releases", async () => {
    const f = await fixture();
    const run = await f.prepare();
    f.deps.repos.blocks.listByThread = async () => {
      throw new Error("history unavailable");
    };
    expect(await run.execute()).toMatchObject({ status: "error" });
    expect(f.journal.getEvents(f.thread.id).map(({ event }) => event.type)).toContain("turn.error");
    expect(f.sink.events.map((event) => event.name)).toEqual(["execution.failed"]);
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
  });

  it("observes terminal fallback failure, settles the run, and releases", async () => {
    const f = await fixture();
    const run = await f.prepare();
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
    expect(f.runtime.getRunningTurn(f.thread.id)).toBeNull();
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
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
        await release(lease);
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
    false,
    true,
  ])("commits child admission and releases before publication B (card failure: %s)", async (failCard) => {
    const f = await fixture();
    const { createChildRunDriver } = await import("../spawn/child-run-driver.js");
    const { createDefaultTreeBudget } = await import("@meridian/contracts/spawn");
    const parentTurn = await f.deps.repos.turns.create({
      threadId: f.thread.id,
      role: "assistant",
      status: "complete",
      prevTurnId: null,
    });
    const child = await f.repos.threads.createSubagent({
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
      orchestrator: f.runtime,
      repos: f.deps.repos,
      eventWriter: f.journal,
      readActivity: async () => ({ descendants: [] }),
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
    false,
    true,
  ])("preserves descendant lifetime at parent completion (child parent: %s)", async (childParent) => {
    const f = await fixture();
    const fg = await f.deps.repos.threads.create({
      userId: f.thread.userId,
      projectId: f.thread.projectId,
    });
    const bg = await f.deps.repos.threads.create({
      userId: f.thread.userId,
      projectId: f.thread.projectId,
    });
    const readBinding = f.deps.agentRevisions.readThreadBinding;
    f.deps.agentRevisions.readThreadBinding = () => readBinding(f.thread.id);
    const parent = await f.runtime.prepare({
      threadId: f.thread.id,
      userText: "parent",
      ...(childParent ? { child: { parentThreadId: "ancestor", background: false } } : {}),
    });
    const foreground = await f.runtime.prepare({
      threadId: fg.id,
      userText: "fg",
      child: { parentThreadId: f.thread.id, background: false },
    });
    const background = await f.runtime.prepare({
      threadId: bg.id,
      userText: "bg",
      child: { parentThreadId: f.thread.id, background: true },
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
      status: "streaming",
      prevTurnId: run.assistantTurnId,
    });
    f.deps.runClaim.readRunningTurnId = async () => other.id;
    f.deps.repos.blocks.listByThread = async () => {
      throw new Error("history unavailable");
    };
    const outcome = await run.execute();
    expect(outcome).toMatchObject({ status: "error", turn: { id: run.assistantTurnId } });
    expect((await f.repos.turns.findById(other.id))?.status).toBe("streaming");
  });

  it("preserves committed terminal truth when only the backstop release fails", async () => {
    let releases = 0;
    const f = await fixture((deps) => {
      const release = deps.runClaim.release;
      deps.runClaim.release = async (lease) => {
        if (++releases === 2) throw new Error("backstop unavailable");
        await release(lease);
      };
    });
    const run = await f.prepare();
    expect(await run.execute()).toMatchObject({
      status: "complete",
      turn: { id: run.assistantTurnId },
    });
    expect(f.sink.events.map((event) => event.name)).toContain("lease_release.failed");
    expect(await f.deps.runClaim.holder(f.thread.id)).toBeNull();
  });
});
