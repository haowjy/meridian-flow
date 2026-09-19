/** Core catalogue stays policy-free. */
import { describe, expect, it, vi } from "vitest";
import {
  createCoreToolRegistrations,
  createToolExecutor,
  createToolRegistry,
} from "../tools/index.js";

function coreExecutor() {
  const write = vi.fn(async () => ({ ok: true }));
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
        id: "call-read",
        name: "write",
        arguments: { command: "read", path: "kb://notes.md" },
      },
      { threadId: "thread-1" as never, turnId: "turn-1" as never, agentSlug: "agent" },
    );
    expect(write).toHaveBeenCalledOnce();
    expect(result).toEqual({ toolCallId: "call-read", output: { ok: true } });
  });
});
