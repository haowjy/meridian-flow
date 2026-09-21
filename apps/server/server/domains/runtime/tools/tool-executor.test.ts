/** Executor capability plumbing for the `thread_message` registration. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SpawnResult } from "@meridian/contracts/spawn";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMessageArgs } from "./spawn-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";
import type { ThreadMessageToolHandlerContext, ToolRegistration } from "./types.js";

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

describe("thread_message capability plumbing", () => {
  it("injects the threadMessage callback declared by the registration", async () => {
    const threadMessageFn = vi.fn(async () => ({ status: "completed" }) as unknown as SpawnResult);
    const executor = createToolExecutor(
      createToolRegistry({ registrations: [threadMessageRegistration()] }),
    );

    const result = await executor.executeTool(
      { id: "call-1", name: "thread_message", arguments: { ref: "p1", message: "p" } },
      { ...executionBase, agentSlug: null, threadMessage: threadMessageFn },
    );

    expect(threadMessageFn).toHaveBeenCalledWith({ ref: "p1", message: "p" });
    expect(result.isError).toBeUndefined();
    expect(result.output).toEqual({ status: "completed" });
  });

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
