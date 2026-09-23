/**
 * `thread_message` dispatch wiring: the tool callback builds a message request,
 * routes foreground/background through the coordinator's single entrypoint,
 * and strips report cost from the transcript tool_result exactly as `spawn`.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import { createDefaultTreeBudget, type SpawnResult } from "@meridian/contracts/spawn";
import type { JsonValue, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import type {
  ChildRunCoordinator,
  ChildRunOptions,
  ChildRunRequest,
} from "../spawn/child-run-coordinator.js";
import {
  createSpawnToolRegistrations,
  createToolExecutor,
  createToolRegistry,
} from "../tools/index.js";
import { defaultInterruptAutoResumePolicy } from "./interrupts.js";
import type { PersistenceDeps } from "./persistence.js";
import {
  dispatchToolCall,
  type ToolDispatchContext,
  type ToolDispatchDeps,
} from "./tool-dispatch.js";

const PARENT_THREAD_ID = "parent-thread" as ThreadId;

const completedResult = {
  status: "completed",
  report: {
    handle: "p1",
    threadId: "child-1",
    summary: "second report",
    costMillicredits: 42,
  },
} as unknown as SpawnResult;
const backgroundResult = {
  status: "background",
  handle: "p1",
  threadId: "child-1",
  agentSlug: "general",
} as unknown as SpawnResult;

function harness() {
  const runChild = vi.fn(async (_request: ChildRunRequest, options: ChildRunOptions) =>
    options.mode === "background" ? backgroundResult : completedResult,
  );
  const coordinator = { runChild } as unknown as ChildRunCoordinator;
  const persistenceDeps = {
    repos: {
      transaction: async (fn: () => Promise<unknown>) => fn(),
      blocks: { upsert: async () => ({}) },
    },
    eventWriter: { appendEvent: async () => 1n },
  } as unknown as PersistenceDeps;
  const deps: ToolDispatchDeps = {
    toolExecutor: createToolExecutor(
      createToolRegistry({ registrations: createSpawnToolRegistrations() }),
    ),
    childRunCoordinator: coordinator,
    eventSink: createInMemoryEventSink(),
    persistenceDeps,
    executionReports: {} as ToolDispatchDeps["executionReports"],
    readSnapshot: async (operation) => operation(),
    workContextDelivery: {} as ToolDispatchDeps["workContextDelivery"],
  };
  const thread = { id: PARENT_THREAD_ID, userId: "user-1" } as unknown as Thread;
  const currentTurn = { id: "turn-1", threadId: PARENT_THREAD_ID } as unknown as Turn;
  const ctx: ToolDispatchContext = {
    thread,
    agentSlug: null,
    responseId: "resp-1",
    state: {
      thread,
      threadId: PARENT_THREAD_ID,
      currentTurn,
      autoResume: defaultInterruptAutoResumePolicy(),
      blockSeqRef: { value: 0 },
      allBlocks: [],
    },
    interruptSession: {
      interrupt: async () => {
        throw new Error("interrupt unused");
      },
      updateComponentBlock: async () => {},
      drainEvents: () => [],
    },
    interruptAutoResume: defaultInterruptAutoResumePolicy(),
    treeBudget: createDefaultTreeBudget(),
    blockSeqRef: { value: 0 },
    allTurns: [],
  };
  return { deps, ctx, runChild };
}

function threadMessageCall(arguments_: Record<string, unknown>) {
  return { id: "call-1", name: "thread_message", arguments: arguments_ };
}

function spawnCall(arguments_: Record<string, unknown>) {
  return { id: "call-2", name: "spawn", arguments: arguments_ };
}

describe("dispatchToolCall thread_message routing", () => {
  it("defaults to background and routes through runChild without a transcript", async () => {
    const { deps, ctx, runChild } = harness();
    const result = await dispatchToolCall(
      deps,
      threadMessageCall({ ref: "p1", message: "keep going" }),
      ctx,
    );
    if ("cancelled" in result) throw new Error("unexpected cancel");

    expect(runChild).toHaveBeenCalledOnce();
    const [request, options] = runChild.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      kind: "message",
      ref: "p1",
      prompt: "keep going",
      toolCallId: "call-1",
    });
    expect(options).toMatchObject({ mode: "background" });
    expect(options).not.toHaveProperty("transcript");
  });

  it("routes foreground through runChild with the parent transcript", async () => {
    const { deps, ctx, runChild } = harness();
    const result = await dispatchToolCall(
      deps,
      threadMessageCall({ ref: "p1", message: "keep going", mode: "foreground" }),
      ctx,
    );
    if ("cancelled" in result) throw new Error("unexpected cancel");

    expect(runChild).toHaveBeenCalledOnce();
    const [request, options] = runChild.mock.calls[0] ?? [];
    expect(request).toMatchObject({ kind: "message", ref: "p1" });
    expect(options).toMatchObject({ mode: "foreground" });
    expect((options as ChildRunOptions).transcript).toBeDefined();
  });

  it("routes a background spawn through runChild with the parent transcript", async () => {
    const { deps, ctx, runChild } = harness();
    const result = await dispatchToolCall(
      deps,
      spawnCall({ agent: "", prompt: "go", mode: "background" }),
      ctx,
    );
    if ("cancelled" in result) throw new Error("unexpected cancel");

    expect(runChild).toHaveBeenCalledOnce();
    const [request, options] = runChild.mock.calls[0] ?? [];
    expect(request).toMatchObject({ kind: "spawn", prompt: "go" });
    expect(options).toMatchObject({ mode: "background" });
    // The durable parent-turn run card is written from this transcript.
    expect((options as ChildRunOptions).transcript).toBeDefined();
  });

  it("strips report cost and threadId, keeping the handle, from the persisted tool_result", async () => {
    const { deps, ctx } = harness();
    const result = await dispatchToolCall(
      deps,
      threadMessageCall({ ref: "p1", message: "keep going", mode: "foreground" }),
      ctx,
    );
    if ("cancelled" in result) throw new Error("unexpected cancel");

    const toolResult = result.events.find((event) => event.type === "tool.result");
    expect(toolResult).toBeDefined();
    const output = (toolResult as { output: JsonValue }).output as {
      report: Record<string, JsonValue>;
    };
    expect(output.report).not.toHaveProperty("costMillicredits");
    expect(output.report).not.toHaveProperty("threadId");
    expect(output.report.handle).toBe("p1");
    expect(output.report.summary).toBe("second report");
  });
});
