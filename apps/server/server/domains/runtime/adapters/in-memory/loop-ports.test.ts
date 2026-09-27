import type { ThreadId } from "@meridian/contracts/runtime";
import type { CurrentToolCall } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryRunClaim } from "./loop-ports.js";

describe("in-memory run current tool", () => {
  it("reports only changed tool calls while the lease is live", async () => {
    const authority = createInMemoryRunClaim({ holderId: "tool-activity" });
    const threadId = "child-thread" as ThreadId;
    const lease = await authority.startExecution(threadId, "run-1");
    if (!lease) throw new Error("expected a run lease");

    const first: CurrentToolCall = {
      toolCallId: "call-1",
      toolName: "spawn",
      input: { agent: "researcher" },
    };
    expect(await authority.setCurrentTool(lease, first)).toBe(true);
    expect(await authority.setCurrentTool(lease, first)).toBe(false);

    const second: CurrentToolCall = {
      toolCallId: "call-2",
      toolName: "thread_report",
      input: { ref: "p3" },
    };
    expect(await authority.setCurrentTool(lease, second)).toBe(true);
    expect((await authority.readMany([threadId])).get(threadId)?.currentTool).toEqual(second);

    await authority.release(lease);
    expect(await authority.readMany([threadId])).toEqual(new Map());
    expect(await authority.setCurrentTool(lease, first)).toBe(false);
  });
});
