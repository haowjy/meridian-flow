/** Core catalogue stays policy-free. */
import { modelResult } from "@meridian/agent-edit/integration";
import { describe, expect, it, vi } from "vitest";
import {
  createCoreToolRegistrations,
  createToolExecutor,
  createToolRegistry,
} from "../tools/index.js";

function coreExecutor() {
  const write = vi.fn(async () => ({
    output: modelResult({ command: "remove", status: "success", phase: "staged" }),
  }));
  const noop = async () => ({ ok: true });
  return {
    write,
    tools: createToolExecutor(
      createToolRegistry({
        registrations: createCoreToolRegistrations({
          read: noop,
          write,
          work: noop,
          ls: noop,
          search: noop,
          ask_user: noop,
        }),
      }),
    ),
  };
}

describe("core catalogue without policy", () => {
  it("runs write when executeTool has no policy", async () => {
    const { write, tools } = coreExecutor();
    const result = await tools.executeTool(
      {
        id: "call-remove",
        name: "write",
        arguments: { command: "remove", path: "kb://notes.md", in: 1 },
      },
      { threadId: "thread-1" as never, turnId: "turn-1" as never, agentSlug: "agent" },
    );
    expect(write).toHaveBeenCalledOnce();
    expect(result).toEqual({
      toolCallId: "call-remove",
      output: "status: success",
      result: {
        schema: "meridian.agent-edit.v1",
        command: "remove",
        status: "success",
        phase: "staged",
      },
    });
  });
});
