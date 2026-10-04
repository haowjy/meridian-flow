/**
 * Executor-level input contracts for the real tool registrations: each
 * tool's defaults, argument mapping and custom refusal messages, plus one row
 * per invalid_arguments message shape. The executor's generic parse-before-
 * dispatch contract lives in tool-executor.test.ts; document selector rules
 * live in agent-edit's command-schema.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { type CoreToolHandlers, createCoreToolRegistrations } from "./core-tools.js";
import { createInspectionToolRegistrations } from "./inspection-tools.js";
import { createSpawnToolRegistrations } from "./spawn-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";
import type { ToolRegistration } from "./types.js";

const execution = { threadId: "thread-1" as never, turnId: "turn-1" as never, agentSlug: null };

function registrations(): ToolRegistration[] {
  const unused = async () => "";
  return [
    ...createCoreToolRegistrations({
      read: unused,
      write: unused,
      work: unused,
      ls: unused,
      search: unused,
      ask_user: unused,
    } as CoreToolHandlers),
    ...createInspectionToolRegistrations({
      repos: {} as never,
      statusReader: {} as never,
      registry: {} as never,
      tokenizer: async () => "anthropic",
    }),
    ...createSpawnToolRegistrations(),
  ];
}

/** The real registrations with a spy for every handler and no capability context. */
function contractHarness() {
  const handler = vi.fn(async (input: unknown) => input);
  const spied = registrations().map(
    ({ capability: _capability, ...registration }): ToolRegistration => ({
      ...registration,
      execution: { type: "server", handler },
    }),
  );
  const executor = createToolExecutor(createToolRegistry({ registrations: spied }));
  return {
    handler,
    call: (name: string, args: Record<string, unknown>) =>
      executor.executeTool({ id: "call-1", name, arguments: args }, execution),
  };
}

async function expectRefused(name: string, args: Record<string, unknown>, issues: string[]) {
  const { handler, call } = contractHarness();
  const result = await call(name, args);
  expect(handler).not.toHaveBeenCalled();
  expect(result.isError).toBe(true);
  expect(result.result).toMatchObject({ error: "invalid_arguments" });
  expect(
    (result.result as { issues: Array<{ path: string; message: string }> }).issues.map(
      ({ path, message }) => `${path}: ${message}`,
    ),
  ).toEqual(issues);
}

async function expectDelivered(name: string, args: Record<string, unknown>, delivered: unknown) {
  const { handler, call } = contractHarness();
  const result = await call(name, args);
  expect(result.isError).toBeUndefined();
  expect(handler).toHaveBeenCalledWith(delivered, expect.anything());
}

describe("issue messages from the real schemas", () => {
  it("render each message shape once, with the argument path", async () => {
    await expectRefused("read", { path: "c.md", in: 0 }, ["in: must be greater than 0"]);
    await expectRefused("ls", { path: "" }, ["path: must not be empty"]);
    await expectRefused("search", {}, ["pattern: required; expected a string"]);
    await expectRefused("thread_ls", { depth: 4 }, ["depth: must be at most 3"]);
    await expectRefused("thread_message", { ref: 7, message: 42 }, [
      "ref: expected a string, got 7",
      "message: expected a string, got 42",
    ]);
    await expectRefused("work", { command: "rename", work: "arc" }, [
      'command: expected "list", "show", "create", "update", "archive", "unarchive", "delete" or "switch", got "rename"',
    ]);
  });
});

describe("thread_ls", () => {
  it("delivers the depth default", async () => {
    await expectDelivered("thread_ls", {}, { depth: 1 });
  });
});

describe("thread_history", () => {
  it("delivers order and limit defaults and either expand handle", async () => {
    await expectDelivered("thread_history", {}, { order: "newest_first", limit: 40 });
    // A turn number arrives as an integer or a string; both are the same handle.
    await expectDelivered(
      "thread_history",
      { expand: 2 },
      { expand: 2, order: "newest_first", limit: 40 },
    );
    await expectDelivered(
      "thread_history",
      { expand: "3.2" },
      { expand: "3.2", order: "newest_first", limit: 40 },
    );
  });

  it("refuses a malformed expand handle", async () => {
    await expectRefused("thread_history", { expand: "2.x" }, [
      'expand: expected a turn number such as 4, or "4.7"',
    ]);
  });
});

describe("thread_report", () => {
  it("refuses run, which used to fall back to the latest report", async () => {
    await expectRefused("thread_report", { ref: "p3", run: 2 }, ["run: unknown argument"]);
  });
});

describe("thread_message", () => {
  it("delivers background mode when mode is omitted", async () => {
    await expectDelivered(
      "thread_message",
      { ref: "p3", message: "Keep going" },
      { ref: "p3", message: "Keep going", mode: "background" },
    );
  });

  it("refuses current with a message naming the fix", async () => {
    await expectRefused("thread_message", { ref: "current", message: "Task" }, [
      "ref: Name the thread to message, e.g. p12",
    ]);
  });
});

describe("spawn", () => {
  it("delivers foreground when mode is omitted", async () => {
    await expectDelivered("spawn", { prompt: "Task" }, { prompt: "Task", mode: "foreground" });
  });

  it("maps the published disallowed_tools key to the configuration spelling", async () => {
    await expectDelivered(
      "spawn",
      {
        prompt: "Task",
        overrides: { effort: "high", disallowed_tools: ["bash"], skills: { load: ["modes"] } },
      },
      {
        prompt: "Task",
        mode: "foreground",
        overrides: { effort: "high", "disallowed-tools": ["bash"], skills: { load: ["modes"] } },
      },
    );
  });

  it("refuses an invalid or misspelled override before spawning", async () => {
    await expectRefused("spawn", { prompt: "Task", overrides: { effort: "max" } }, [
      'overrides.effort: expected "low", "medium", "high", "xhigh", "none", "disabled" or "adaptive", got "max"',
    ]);
    await expectRefused("spawn", { prompt: "Task", overrides: { "disallowed-tools": ["bash"] } }, [
      "overrides.disallowed-tools: unknown argument",
    ]);
  });
});

describe("return_result", () => {
  it("delivers artifact URIs as object refs and keeps an explicit null payload", async () => {
    await expectDelivered(
      "return_result",
      { summary: "done", payload: null, artifacts: ["scratch://the-lamplighters-arithmetic.md"] },
      {
        summary: "done",
        payload: null,
        artifacts: [{ type: "object", uri: "scratch://the-lamplighters-arithmetic.md" }],
      },
    );
  });

  it("refuses artifacts that aren't Meridian document URIs", async () => {
    await expectRefused(
      "return_result",
      { summary: "done", artifacts: ["https://example.test/cover.png"] },
      [
        'artifacts[0]: Expected a Meridian document URI, received "https://example.test/cover.png".',
      ],
    );
  });
});

describe("work", () => {
  it("strips one leading @ and surrounding space from Work refs", async () => {
    await expectDelivered(
      "work",
      { command: "show", work: " @arc " },
      { command: "show", work: "arc" },
    );
    await expectDelivered(
      "work",
      { command: "switch", target: "@arc" },
      { command: "switch", target: "arc" },
    );
    await expectDelivered(
      "work",
      { command: "switch", target: null },
      { command: "switch", target: null },
    );
    await expectRefused("work", { command: "show", work: "@" }, [
      'work: must name a Work slug, e.g. "arc" or "@arc"',
    ]);
  });

  it("normalizes metadata by the shared clearing rule", async () => {
    await expectDelivered(
      "work",
      { command: "create", name: "  Arc  ", goal: "   " },
      { command: "create", name: "Arc", goal: null },
    );
    await expectDelivered(
      "work",
      { command: "update", work: "arc", goal: null, status: "  Needs\n outline " },
      { command: "update", work: "arc", goal: null, status: "Needs outline" },
    );
    await expectDelivered(
      "work",
      { command: "update", work: "arc", status: "" },
      { command: "update", work: "arc", status: null },
    );
  });

  it("refuses blank or null names and long statuses", async () => {
    await expectRefused("work", { command: "create", name: "   ", goal: "   " }, [
      "name: must not be blank",
    ]);
    await expectRefused("work", { command: "update", work: "arc", name: null }, [
      "name: expected a string, got null",
    ]);
    await expectRefused("work", { command: "update", work: "arc", status: "x".repeat(33) }, [
      "status: must be one to three words and 32 characters or fewer",
    ]);
  });
});

describe("ask_user", () => {
  it("maps snake_case arguments to the ask input", async () => {
    await expectDelivered(
      "ask_user",
      { question: "Proceed?", kind: "free-text", requires_human: true, timeout_ms: 5000 },
      {
        question: "Proceed?",
        kind: "free-text",
        recommended: null,
        requiresHuman: true,
        timeoutMs: 5000,
      },
    );
  });

  it("refuses camelCase and a choice with no options", async () => {
    await expectRefused("ask_user", { question: "Q", kind: "free-text", timeoutMs: 10 }, [
      "timeoutMs: unknown argument",
    ]);
    await expectRefused("ask_user", { question: "Q", kind: "choice" }, [
      "options: choice needs at least one { value, label } option",
    ]);
  });
});
