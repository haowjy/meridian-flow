/** Consolidated test contracts; each block retains its original fixture scope. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe as __mergedSuite, expect, it, vi } from "vitest";
import { z } from "zod";
import { threadReadError } from "../spawn/resolve-readable-thread.js";
import { createSpawnToolRegistrations } from "./spawn-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";
import type { ToolRegistration } from "./types.js";

__mergedSuite("tool-executor.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/tools/tool-executor.test.ts.
  const executionBase = {
    threadId: "thread-1" as ThreadId,
    turnId: "turn-1" as TurnId,
  };

  function executorFor(name: "thread_message" | "thread_report") {
    const registrations = createSpawnToolRegistrations().filter(
      (registration) => registration.definition.name === name,
    );
    return createToolExecutor(createToolRegistry({ registrations }));
  }

  it("marks a structured thread-report refusal as an error result", async () => {
    const result = await executorFor("thread_report").executeTool(
      { id: "call-denied", name: "thread_report", arguments: { ref: "p9" } },
      {
        ...executionBase,
        agentSlug: null,
        threadReport: async () => threadReadError("thread_not_connected", "Not connected"),
      },
    );
    expect(result.isError).toBe(true);
    expect(result.result).toMatchObject({ code: "thread_not_connected" });
  });

  __mergedSuite("input parsing before dispatch", () => {
    const input = z
      .object({
        mode: z.enum(["foreground", "background"]).default("foreground"),
        count: z.number().int().positive().optional(),
      })
      .strict();
    function parsingExecutor() {
      const handler = vi.fn(async (parsed: unknown) => parsed);
      const registration: ToolRegistration = {
        source: "core",
        definition: { type: "function", name: "probe", description: "", inputSchema: {} },
        input,
        execution: { type: "server", handler },
      };
      return {
        handler,
        executor: createToolExecutor(createToolRegistry({ registrations: [registration] })),
      };
    }
    it("refuses invalid values and unknown keys without calling the handler", async () => {
      const { handler, executor } = parsingExecutor();
      const result = await executor.executeTool(
        { id: "call-1", name: "probe", arguments: { mode: "invalid", count: 1.5, extra: true } },
        { ...executionBase, agentSlug: null },
      );
      expect(handler).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.result).toMatchObject({
        error: "invalid_arguments",
        issues: [{ path: "mode" }, { path: "count" }, { path: "extra" }],
      });
    });
  });
});

__mergedSuite("spawn-tools.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/tools/spawn-tools.test.ts.
  __mergedSuite("spawn and thread_message refusals", () => {
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
});
