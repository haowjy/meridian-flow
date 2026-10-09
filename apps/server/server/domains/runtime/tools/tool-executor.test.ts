/** Executor input parsing and capability plumbing for spawn-family registrations. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { threadReadError } from "../spawn/resolve-readable-thread.js";
import { createSpawnToolRegistrations } from "./spawn-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";
import type { ToolRegistration } from "./types.js";

const executionBase = { threadId: "thread-1" as ThreadId, turnId: "turn-1" as TurnId };

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

describe("input parsing before dispatch", () => {
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
