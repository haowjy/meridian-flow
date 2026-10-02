/**
 * Executor-level input contracts for every non-document tool: the audit's
 * silent-fallback reproductions (C1) now refuse with invalid_arguments and
 * never reach the handler, and valid input reaches it parsed.
 */
import { describe, expect, it, vi } from "vitest";
import { type CoreToolHandlers, createCoreToolRegistrations } from "./core-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";
import type { ToolRegistration } from "./types.js";

const execution = { threadId: "thread-1" as never, turnId: "turn-1" as never, agentSlug: null };

function registrations(): ToolRegistration[] {
  const unused = async () => "";
  return [
    ...createCoreToolRegistrations({
      write: unused,
      work: unused,
      ls: unused,
      search: unused,
      ask_user: unused,
    } as CoreToolHandlers),
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
  expect(result.output).toMatchObject({ error: "invalid_arguments" });
  expect(
    (result.output as { issues: Array<{ path: string; message: string }> }).issues.map(
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
