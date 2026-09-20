/**
 * `continue` dispatch wiring: the tool callback maps args onto the coordinator
 * input, routes foreground/background, and strips report cost from the
 * transcript tool_result exactly as `spawn` does.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import { createDefaultTreeBudget, type SpawnResult } from "@meridian/contracts/spawn";
import type { JsonValue, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import type { ChildRunCoordinator, ContinueChildInput } from "../spawn/child-run-coordinator.js";
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
    handle: "s1",
    threadId: "child-1",
    summary: "second report",
    costMillicredits: 42,
  },
} as unknown as SpawnResult;
const backgroundResult = {
  status: "background",
  handle: "s1",
  threadId: "child-1",
  agentSlug: "general",
} as unknown as SpawnResult;

function harness() {
  const continueChild = vi.fn(async (_input: ContinueChildInput) => completedResult);
  const continueChildBackground = vi.fn(async (_input: ContinueChildInput) => backgroundResult);
  const coordinator = {
    continueChild,
    continueChildBackground,
  } as unknown as ChildRunCoordinator;
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
  return { deps, ctx, continueChild, continueChildBackground };
}

function continueCall(arguments_: Record<string, unknown>) {
  return { id: "call-1", name: "continue", arguments: arguments_ };
}

describe("dispatchToolCall continue routing", () => {
  it("routes the default foreground mode through continueChild with the parent transcript", async () => {
    const { deps, ctx, continueChild, continueChildBackground } = harness();
    const result = await dispatchToolCall(
      deps,
      continueCall({ handle: "s1", prompt: "keep going" }),
      ctx,
    );
    if ("cancelled" in result) throw new Error("unexpected cancel");

    expect(continueChildBackground).not.toHaveBeenCalled();
    expect(continueChild).toHaveBeenCalledOnce();
    const input = continueChild.mock.calls[0]?.[0];
    expect(input).toMatchObject({ handle: "s1", prompt: "keep going" });
    expect(input?.transcript).toBeDefined();
  });

  it("routes background mode through continueChildBackground without a transcript", async () => {
    const { deps, ctx, continueChild, continueChildBackground } = harness();
    const result = await dispatchToolCall(
      deps,
      continueCall({ handle: "s1", prompt: "check later", mode: "background" }),
      ctx,
    );
    if ("cancelled" in result) throw new Error("unexpected cancel");

    expect(continueChild).not.toHaveBeenCalled();
    expect(continueChildBackground).toHaveBeenCalledOnce();
    expect(continueChildBackground.mock.calls[0]?.[0]).not.toHaveProperty("transcript");
  });

  it("strips report cost and threadId, keeping the handle, from the persisted tool_result", async () => {
    const { deps, ctx } = harness();
    const result = await dispatchToolCall(
      deps,
      continueCall({ handle: "s1", prompt: "keep going" }),
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
    expect(output.report.handle).toBe("s1");
    expect(output.report.summary).toBe("second report");
  });
});
