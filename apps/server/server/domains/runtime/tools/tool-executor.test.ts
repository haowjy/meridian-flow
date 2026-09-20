/** Executor capability plumbing for the `continue` registration. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SpawnResult } from "@meridian/contracts/spawn";
import { describe, expect, it, vi } from "vitest";
import type { ContinueToolArgs } from "./spawn-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";
import type { ContinueToolHandlerContext, ToolRegistration } from "./types.js";

function continueRegistration(): ToolRegistration {
  return {
    source: "spawn",
    definition: {
      type: "function",
      name: "continue",
      description: "continue",
      inputSchema: { type: "object" },
    },
    execution: {
      type: "server",
      handler: async (input: unknown, ctx: ContinueToolHandlerContext) =>
        ctx.continue(input as ContinueToolArgs),
    },
    capability: "continue",
    advertise: true,
  };
}

const executionBase = { threadId: "thread-1" as ThreadId, turnId: "turn-1" as TurnId };

describe("continue capability plumbing", () => {
  it("injects the continue callback declared by the registration", async () => {
    const continueFn = vi.fn(async () => ({ status: "completed" }) as unknown as SpawnResult);
    const executor = createToolExecutor(
      createToolRegistry({ registrations: [continueRegistration()] }),
    );

    const result = await executor.executeTool(
      { id: "call-1", name: "continue", arguments: { handle: "s1", prompt: "p" } },
      { ...executionBase, agentSlug: null, continue: continueFn },
    );

    expect(continueFn).toHaveBeenCalledWith({ handle: "s1", prompt: "p" });
    expect(result.isError).toBeUndefined();
    expect(result.output).toEqual({ status: "completed" });
  });

  it("fails the call when the continue context is absent", async () => {
    const executor = createToolExecutor(
      createToolRegistry({ registrations: [continueRegistration()] }),
    );

    const result = await executor.executeTool(
      { id: "call-1", name: "continue", arguments: { handle: "s1", prompt: "p" } },
      { ...executionBase, agentSlug: null },
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain("missing continue context");
  });
});
