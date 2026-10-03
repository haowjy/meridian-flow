/**
 * Executor-level input contracts for every non-document tool: the audit's
 * silent-fallback reproductions (C1) now refuse with invalid_arguments and
 * never reach the handler, and valid input reaches it parsed.
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

describe("read and write selectors", () => {
  it("refuse competing selectors and modifiers without find before the handler", async () => {
    await expectRefused("read", { path: "c.md#scene", in: 1 }, [
      "in: Use one of in, around or a #fragment",
    ]);
    await expectRefused(
      "write",
      { command: "replace", path: "c.md", content: "x", in: 1, all: true },
      ["all: all applies to find matches"],
    );
    await expectRefused("write", { command: "insert", path: "c.md", content: "x", in: 2 }, [
      "in: insert positions with after, before or find",
    ]);
    await expectRefused("write", { command: "remove", path: "c.md" }, [
      "path: remove needs exactly one of `in` or a #heading-slug in path",
    ]);
    await expectRefused("write", { command: "replace", path: "c.md", content: "x" }, [
      "arguments: replace needs `in`, `find` or a #heading-slug in path",
    ]);
  });

  it("refuse undo's old from range start and a since without to", async () => {
    await expectRefused("write", { command: "undo", path: "c.md", from: "w1", to: "w3" }, [
      "from: unknown argument",
    ]);
    await expectRefused("write", { command: "redo", path: "c.md", since: "w1" }, [
      "since: since starts a range; add to",
    ]);
  });

  it("refuse block number zero and empty insert content", async () => {
    await expectRefused("read", { path: "c.md", in: 0 }, ["in: must be greater than 0"]);
    await expectRefused("write", { command: "insert", path: "c.md", content: "" }, [
      "content: must not be empty",
    ]);
  });
});

describe("ls", () => {
  it("delivers an omitted or supplied path", async () => {
    await expectDelivered("ls", {}, {});
    await expectDelivered("ls", { path: "kb://" }, { path: "kb://" });
  });

  it("refuses an empty path, a non-string path and unknown keys", async () => {
    await expectRefused("ls", { path: "" }, ["path: must not be empty"]);
    await expectRefused("ls", { path: 3 }, ["path: expected a string, got 3"]);
    await expectRefused("ls", { dir: "kb://" }, ["dir: unknown argument"]);
  });
});

describe("search", () => {
  it("delivers a pattern with an optional scope", async () => {
    await expectDelivered("search", { pattern: "mirror" }, { pattern: "mirror" });
    await expectDelivered(
      "search",
      { pattern: "mirror", scope: "kb://" },
      { pattern: "mirror", scope: "kb://" },
    );
  });

  it("refuses a missing or empty pattern, an empty scope and unknown keys", async () => {
    await expectRefused("search", {}, ["pattern: required; expected a string"]);
    await expectRefused("search", { pattern: "" }, ["pattern: must not be empty"]);
    await expectRefused("search", { pattern: "x", scope: "" }, ["scope: must not be empty"]);
    await expectRefused("search", { pattern: "x", regex: true }, ["regex: unknown argument"]);
  });
});

describe("thread_ls", () => {
  it("delivers the depth default and an explicit current ref", async () => {
    await expectDelivered("thread_ls", {}, { depth: 1 });
    await expectDelivered("thread_ls", { ref: "current", depth: 2 }, { ref: "current", depth: 2 });
  });

  it("refuses an out-of-range depth, an empty ref and unknown keys", async () => {
    await expectRefused("thread_ls", { depth: 4 }, ["depth: must be at most 3"]);
    await expectRefused("thread_ls", { depth: 1.5 }, ["depth: expected a whole number, got 1.5"]);
    await expectRefused("thread_ls", { ref: "" }, ["ref: must not be empty"]);
    await expectRefused("thread_ls", { limit: 5 }, ["limit: unknown argument"]);
  });
});

describe("thread_history", () => {
  it("delivers order and limit defaults", async () => {
    await expectDelivered("thread_history", {}, { order: "newest_first", limit: 40 });
    await expectDelivered(
      "thread_history",
      { ref: "current", expand: "3.2" },
      { ref: "current", expand: "3.2", order: "newest_first", limit: 40 },
    );
    // A turn number arrives as an integer or a string; both are the same handle.
    await expectDelivered(
      "thread_history",
      { expand: 2 },
      { expand: 2, order: "newest_first", limit: 40 },
    );
    await expectDelivered(
      "thread_history",
      { expand: "2" },
      { expand: "2", order: "newest_first", limit: 40 },
    );
  });

  it("refuses bad values and unknown keys", async () => {
    await expectRefused("thread_history", { order: "latest" }, [
      'order: expected "newest_first" or "oldest_first", got "latest"',
    ]);
    await expectRefused("thread_history", { limit: 0 }, ["limit: must be at least 1"]);
    await expectRefused("thread_history", { include: ["everything"] }, [
      'include[0]: expected "routine_calls", "tool_args", "tool_results", "thinking", "system_messages", "system_prompt" or "timestamps", got "everything"',
    ]);
    await expectRefused("thread_history", { expand: "2.x" }, [
      'expand: expected a turn number such as 4, or "4.7"',
    ]);
    await expectRefused("thread_history", { expand: 1.5 }, [
      'expand: expected a turn number such as 4, or "4.7"',
    ]);
    await expectRefused("thread_history", { turn: 3 }, ["turn: unknown argument"]);
  });
});

describe("thread_report", () => {
  it("delivers a ref", async () => {
    await expectDelivered("thread_report", { ref: "p3" }, { ref: "p3" });
    await expectDelivered("thread_report", { ref: "current" }, { ref: "current" });
  });

  it("refuses run, which used to fall back to the latest report, and a missing ref", async () => {
    for (const run of [0, 1.5, "2", 2]) {
      await expectRefused("thread_report", { ref: "p3", run }, ["run: unknown argument"]);
    }
    await expectRefused("thread_report", {}, ["ref: required; expected a string"]);
    await expectRefused("thread_report", { ref: "" }, ["ref: must not be empty"]);
  });
});

describe("thread_message", () => {
  it("delivers background mode only when mode is omitted", async () => {
    await expectDelivered(
      "thread_message",
      { ref: "p3", message: "Keep going" },
      { ref: "p3", message: "Keep going", mode: "background" },
    );
    await expectDelivered(
      "thread_message",
      { ref: "p3", message: "Keep going", mode: "foreground" },
      { ref: "p3", message: "Keep going", mode: "foreground" },
    );
  });

  it("refuses the inputs it used to fill with empty strings or background", async () => {
    await expectRefused("thread_message", { ref: "p3" }, ["message: required; expected a string"]);
    await expectRefused("thread_message", { ref: "p3", message: "Task", mode: "invalid" }, [
      'mode: expected "foreground" or "background", got "invalid"',
    ]);
    await expectRefused("thread_message", { ref: 7, message: 42 }, [
      "ref: expected a string, got 7",
      "message: expected a string, got 42",
    ]);
    await expectRefused("thread_message", { ref: "p3", message: "" }, [
      "message: must not be empty",
    ]);
  });

  it("refuses current with a message naming the fix", async () => {
    await expectRefused("thread_message", { ref: "current", message: "Task" }, [
      "ref: Name the thread to message, e.g. p12",
    ]);
  });
});

describe("spawn", () => {
  it("delivers foreground only when mode is omitted", async () => {
    await expectDelivered("spawn", { prompt: "Task" }, { prompt: "Task", mode: "foreground" });
    await expectDelivered(
      "spawn",
      { prompt: "Task", mode: "background", from: "current", append_system_prompt: "Be brief." },
      { prompt: "Task", mode: "background", from: "current", append_system_prompt: "Be brief." },
    );
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

  it("refuses the inputs it used to fill with defaults or drop", async () => {
    await expectRefused("spawn", {}, ["prompt: required; expected a string"]);
    await expectRefused("spawn", { prompt: "" }, ["prompt: must not be empty"]);
    await expectRefused("spawn", { prompt: "Task", mode: "invalid" }, [
      'mode: expected "foreground" or "background", got "invalid"',
    ]);
    await expectRefused("spawn", { prompt: "Task", agent: 42 }, [
      "agent: expected a string, got 42",
    ]);
    await expectRefused("spawn", { prompt: "Task", from: null }, [
      "from: expected a string, got null",
    ]);
    await expectRefused("spawn", { prompt: "Task", append_system_prompt: 42 }, [
      "append_system_prompt: expected a string, got 42",
    ]);
    await expectRefused("spawn", { prompt: "Task", overrides: "invalid" }, [
      'overrides: expected an object, got "invalid"',
    ]);
    await expectRefused("spawn", { prompt: "Task", extra: true }, ["extra: unknown argument"]);
  });

  it("refuses an invalid or misspelled override before spawning", async () => {
    await expectRefused("spawn", { prompt: "Task", overrides: { effort: "max" } }, [
      'overrides.effort: expected "low", "medium", "high", "xhigh", "none", "disabled" or "adaptive", got "max"',
    ]);
    await expectRefused("spawn", { prompt: "Task", overrides: { "disallowed-tools": ["bash"] } }, [
      "overrides.disallowed-tools: unknown argument",
    ]);
    await expectRefused("spawn", { prompt: "Task", overrides: { skills: { preload: [] } } }, [
      "overrides.skills.preload: unknown argument",
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

  it("refuses artifacts that aren't Meridian document URI strings", async () => {
    await expectRefused(
      "return_result",
      { summary: "done", artifacts: ["https://example.test/cover.png"] },
      [
        'artifacts[0]: Expected a Meridian document URI, received "https://example.test/cover.png".',
      ],
    );
    await expectRefused("return_result", { summary: "done", artifacts: ["not a Meridian URI"] }, [
      'artifacts[0]: Expected a Meridian document URI, received "not a Meridian URI".',
    ]);
    await expectRefused(
      "return_result",
      { summary: "done", artifacts: [{ type: "object", uri: "scratch://draft.md" }] },
      ['artifacts[0]: expected a string, got {"type":"object","uri":"scratch://draft.md"}'],
    );
  });

  it("refuses a missing summary and unknown keys", async () => {
    await expectRefused("return_result", {}, ["summary: required; expected a string"]);
    await expectRefused("return_result", { summary: "done", outcome: "ok" }, [
      "outcome: unknown argument",
    ]);
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

  it("refuses blank or null names, long statuses, unknown keys and commands", async () => {
    await expectRefused("work", { command: "create", name: "   ", goal: "   " }, [
      "name: must not be blank",
    ]);
    await expectRefused("work", { command: "update", work: "arc", name: null }, [
      "name: expected a string, got null",
    ]);
    await expectRefused("work", { command: "update", work: "arc", status: "x".repeat(33) }, [
      "status: must be one to three words and 32 characters or fewer",
    ]);
    await expectRefused("work", { command: "update", work: "arc", extra: true }, [
      "extra: unknown argument",
    ]);
    await expectRefused("work", { command: "rename", work: "arc" }, [
      'command: expected "list", "show", "create", "update", "archive", "unarchive", "delete" or "switch", got "rename"',
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

  it("refuses camelCase, coerced values and a choice with no options", async () => {
    await expectRefused("ask_user", { question: "Q", kind: "free-text", timeoutMs: 10 }, [
      "timeoutMs: unknown argument",
    ]);
    await expectRefused("ask_user", { question: "Q", kind: "free-text", timeout_ms: 1.5 }, [
      "timeout_ms: expected a whole number, got 1.5",
    ]);
    await expectRefused("ask_user", { question: "Q", kind: "free-text", requires_human: "yes" }, [
      'requires_human: expected a boolean, got "yes"',
    ]);
    await expectRefused("ask_user", { question: "Q", kind: "choice" }, [
      "options: choice needs at least one { value, label } option",
    ]);
  });
});
