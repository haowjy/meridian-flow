/** Spawn-family registrations: advertised schemas, guidance copy and handler results. */
import { describe, expect, it } from "vitest";
import { createSpawnToolRegistrations } from "./spawn-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";

describe("spawn and thread_message refusals", () => {
  const executor = createToolExecutor(
    createToolRegistry({ registrations: createSpawnToolRegistrations() }),
  );
  const refusal = {
    status: "error" as const,
    error: {
      code: "thread_message_target_busy",
      message: "Child thread already has an active run",
    },
  };
  const context = { threadId: "thread-1" as never, turnId: "turn-1" as never, agentSlug: null };

  it("reach the model as errors when no run started", async () => {
    const spawned = await executor.executeTool(
      { id: "call-spawn", name: "spawn", arguments: { prompt: "Check chapter 3." } },
      { ...context, spawn: async () => refusal as never },
    );
    const messaged = await executor.executeTool(
      { id: "call-message", name: "thread_message", arguments: { ref: "p2", message: "Again." } },
      { ...context, threadMessage: async () => refusal as never },
    );

    for (const result of [spawned, messaged]) {
      expect(result).toMatchObject({ isError: true, result: refusal });
    }
  });

  it("leave a run that started and failed as a delivered report", async () => {
    const failed = {
      status: "error" as const,
      execution: "execution-2",
      outcome: "failed" as const,
      error: { code: "child_failed", message: "Child run failed" },
      report: { handle: "p2", threadId: "child-2", source: "empty" as const, summary: "" },
    };
    const result = await executor.executeTool(
      { id: "call-spawn", name: "spawn", arguments: { prompt: "Check chapter 3." } },
      { ...context, spawn: async () => failed as never },
    );
    expect(result.isError).toBeUndefined();
    expect(result.result).toEqual(failed);
  });
});
