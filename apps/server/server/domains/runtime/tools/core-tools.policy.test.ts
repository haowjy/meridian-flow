/** Critic replace is refused before the write handler; Critic read and Writer replace run. */
import { describe, expect, it, vi } from "vitest";
import { projectToolPolicy } from "../loop/permissions/project-tool-policy.js";
import { type CoreToolHandlers, createCoreToolRegistrations } from "./core-tools.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";

const WRITER_MAP = {
  read: "allow",
  write: "allow",
  edit: "allow",
  ask_user: "allow",
} as const;

const CRITIC_MAP = {
  read: "allow",
  write: "deny",
  edit: "deny",
  ask_user: "allow",
} as const;

const execution = {
  threadId: "thread-1" as never,
  turnId: "turn-1" as never,
  agentSlug: "agent",
};

function executor(handlers: Partial<CoreToolHandlers> = {}) {
  const write = handlers.write ?? vi.fn(async () => ({ ok: true }));
  const work = handlers.work ?? vi.fn(async () => ({ ok: true }));
  const noop = async () => ({ ok: true });
  const registrations = createCoreToolRegistrations({
    write,
    work,
    ls: noop,
    search: noop,
    ask_user: noop,
  });
  return {
    write,
    work,
    tools: createToolExecutor(createToolRegistry({ registrations })),
  };
}

describe("core tool command policy", () => {
  it("refuses Critic replace without calling the write handler", async () => {
    const { write, tools } = executor();
    const result = await tools.executeTool(
      {
        id: "call-replace",
        name: "write",
        arguments: { command: "replace", path: "kb://notes.md", content: "nope" },
      },
      { ...execution, toolPolicy: projectToolPolicy({ tools: CRITIC_MAP }) },
    );
    expect(write).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      toolCallId: "call-replace",
      isError: true,
      output: {
        code: "tool_error",
        message: 'Command "replace" is not enabled for write.',
        source: "tool",
      },
    });
  });

  it("runs Critic write read", async () => {
    const { write, tools } = executor();
    const result = await tools.executeTool(
      {
        id: "call-read",
        name: "write",
        arguments: { command: "read", path: "kb://notes.md" },
      },
      { ...execution, toolPolicy: projectToolPolicy({ tools: CRITIC_MAP }) },
    );
    expect(write).toHaveBeenCalledOnce();
    expect(result).toEqual({ toolCallId: "call-read", output: { ok: true } });
  });

  it("runs Writer write replace", async () => {
    const { write, tools } = executor();
    const result = await tools.executeTool(
      {
        id: "call-replace",
        name: "write",
        arguments: { command: "replace", path: "kb://notes.md", content: "yes" },
      },
      { ...execution, toolPolicy: projectToolPolicy({ tools: WRITER_MAP }) },
    );
    expect(write).toHaveBeenCalledOnce();
    expect(result).toEqual({ toolCallId: "call-replace", output: { ok: true } });
  });
});
