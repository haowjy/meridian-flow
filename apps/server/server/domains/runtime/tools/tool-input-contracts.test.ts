/**
 * Executor-level input contracts for the real tool registrations: argument
 * mapping and cross-field rules no generated schema shows. The executor's
 * generic parse-before-dispatch contract lives in tool-executor.test.ts;
 * document selector rules live in agent-edit's command-schema.test.ts.
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

async function expectRefused(name: string, args: Record<string, unknown>, path: string) {
  const { handler, call } = contractHarness();
  const result = await call(name, args);
  expect(handler).not.toHaveBeenCalled();
  expect(result.result).toMatchObject({ error: "invalid_arguments", issues: [{ path }] });
}

async function expectDelivered(name: string, args: Record<string, unknown>, delivered: unknown) {
  const { handler, call } = contractHarness();
  const result = await call(name, args);
  expect(result.isError).toBeUndefined();
  expect(handler).toHaveBeenCalledWith(delivered, expect.anything());
}

describe("argument mapping", () => {
  it("maps spawn's published disallowed_tools key to the configuration spelling", async () => {
    await expectDelivered(
      "spawn",
      { prompt: "Task", overrides: { disallowed_tools: ["bash"] } },
      { prompt: "Task", mode: "foreground", overrides: { "disallowed-tools": ["bash"] } },
    );
  });

  it("delivers return_result artifact URIs as object refs", async () => {
    await expectDelivered(
      "return_result",
      { summary: "done", artifacts: ["scratch://notes.md"] },
      { summary: "done", artifacts: [{ type: "object", uri: "scratch://notes.md" }] },
    );
  });

  it("strips one leading @ from Work refs", async () => {
    await expectDelivered(
      "work",
      { command: "switch", target: "@arc" },
      { command: "switch", target: "arc" },
    );
  });

  it("maps ask_user's snake_case arguments to the ask input", async () => {
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
});

describe("cross-field rules", () => {
  it("refuses an ask_user choice with no options", async () => {
    await expectRefused("ask_user", { question: "Q", kind: "choice" }, "options");
  });
});
