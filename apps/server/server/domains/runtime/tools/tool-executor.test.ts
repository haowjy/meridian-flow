/** Executor input parsing and capability plumbing for spawn-family registrations. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ModelThreadReportResult } from "@meridian/contracts/spawn";
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
  it("injects the latest-report reader", async () => {
    const expected: ModelThreadReportResult = { ref: "p1", status: "unavailable" };
    const threadReportFn = vi.fn(async () => expected);
    const executor = executorFor("thread_report");
    const result = await executor.executeTool(
      {
        id: "call-1",
        name: "thread_report",
        arguments: { ref: "p1" },
      },
      { ...executionBase, agentSlug: null, threadReport: threadReportFn },
    );
    // The model reads text; the typed result rides beside it.
    expect(result.result).toEqual({ ref: "p1", status: "unavailable" });
    expect(result.output).toEqual(expect.any(String));
  });
});

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
    expect(result).toEqual({
      toolCallId: "call-1",
      isError: true,
      output: [
        "Invalid arguments for probe:",
        '- mode: expected "foreground" or "background", got "invalid"',
        "- count: expected a whole number, got 1.5",
        "- extra: unknown argument",
      ].join("\n"),
      result: {
        error: "invalid_arguments",
        issues: [
          { path: "mode", message: 'expected "foreground" or "background", got "invalid"' },
          { path: "count", message: "expected a whole number, got 1.5" },
          { path: "extra", message: "unknown argument" },
        ],
      },
    });
  });

  it("hands the handler the parsed value with omitted defaults applied", async () => {
    const { handler, executor } = parsingExecutor();
    const result = await executor.executeTool(
      { id: "call-1", name: "probe", arguments: {} },
      { ...executionBase, agentSlug: null },
    );
    expect(handler).toHaveBeenCalledWith({ mode: "foreground" }, expect.anything());
    expect(result.output).toEqual({ mode: "foreground" });
  });

  it("keeps the typed result beside the output for a tool with no renderer", async () => {
    const { executor } = parsingExecutor();
    const result = await executor.executeTool(
      { id: "call-1", name: "probe", arguments: { count: 2 } },
      { ...executionBase, agentSlug: null },
    );
    expect(result.result).toEqual({ mode: "foreground", count: 2 });
    expect(result.output).toEqual(result.result);
  });
});
