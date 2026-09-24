/** Executor capability plumbing for the `thread_message` registration. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ThreadReportResult } from "@meridian/contracts/spawn";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMessageArgs, ThreadReportArgs } from "./spawn-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";
import type {
  ThreadMessageToolHandlerContext,
  ThreadReportToolHandlerContext,
  ToolRegistration,
} from "./types.js";

function threadMessageRegistration(): ToolRegistration {
  return {
    source: "spawn",
    definition: {
      type: "function",
      name: "thread_message",
      description: "thread_message",
      inputSchema: { type: "object" },
    },
    execution: {
      type: "server",
      handler: async (input: unknown, ctx: ThreadMessageToolHandlerContext) =>
        ctx.threadMessage(input as ThreadMessageArgs),
    },
    capability: "thread_message",
    advertise: true,
  };
}

const executionBase = { threadId: "thread-1" as ThreadId, turnId: "turn-1" as TurnId };

function threadReportRegistration(): ToolRegistration {
  return {
    source: "spawn",
    definition: {
      type: "function",
      name: "thread_report",
      description: "thread_report",
      inputSchema: { type: "object" },
    },
    execution: {
      type: "server",
      handler: async (input: unknown, ctx: ThreadReportToolHandlerContext) =>
        ctx.threadReport(input as ThreadReportArgs),
    },
    capability: "thread_report",
    advertise: true,
  };
}

describe("thread_message capability plumbing", () => {
  it("fails the call when the threadMessage context is absent", async () => {
    const executor = createToolExecutor(
      createToolRegistry({ registrations: [threadMessageRegistration()] }),
    );

    const result = await executor.executeTool(
      { id: "call-1", name: "thread_message", arguments: { ref: "p1", message: "p" } },
      { ...executionBase, agentSlug: null },
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain("missing threadMessage context");
  });
});

describe("thread_report capability plumbing", () => {
  it("injects the exact-report reader", async () => {
    const expected: ThreadReportResult = {
      ref: "p1",
      execution: "00000000-0000-4000-8000-000000000001" as TurnId,
      status: "unavailable",
    };
    const threadReportFn = vi.fn(async () => expected);
    const executor = createToolExecutor(
      createToolRegistry({ registrations: [threadReportRegistration()] }),
    );
    const result = await executor.executeTool(
      {
        id: "call-1",
        name: "thread_report",
        arguments: { ref: "p1", execution: expected.execution },
      },
      { ...executionBase, agentSlug: null, threadReport: threadReportFn },
    );
    expect(threadReportFn).toHaveBeenCalledWith({ ref: "p1", execution: expected.execution });
    expect(result.output).toEqual(expected);
  });
});
