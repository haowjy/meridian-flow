/** Executor capability plumbing for the `thread_message` registration. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ThreadReportResult } from "@meridian/contracts/spawn";
import { describe, expect, it, vi } from "vitest";
import { createSpawnToolRegistrations } from "./spawn-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";

const executionBase = { threadId: "thread-1" as ThreadId, turnId: "turn-1" as TurnId };

function executorFor(name: "thread_message" | "thread_report") {
  const registrations = createSpawnToolRegistrations().filter(
    (registration) => registration.definition.name === name,
  );
  return createToolExecutor(createToolRegistry({ registrations }));
}

describe("thread_message capability plumbing", () => {
  it("fails the call when the threadMessage context is absent", async () => {
    const executor = executorFor("thread_message");

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
    const executor = executorFor("thread_report");
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
