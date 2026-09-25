/** Remembered identity includes subagents and never defaults to the first list row. */
import { describe, expect, it } from "vitest";
import { resolveChatThreadId } from "./chat-thread-resolution";

describe("current chat identity", () => {
  it("uses the path identity before local continuity", () => {
    expect(resolveChatThreadId("path", { kind: "thread", threadId: "remembered" })).toBe("path");
  });
  it("retains a remembered subagent without a primary catalog lookup", () => {
    expect(resolveChatThreadId(null, { kind: "thread", threadId: "child" })).toBe("child");
  });
  it.each(["new", "none"] as const)("does not select a thread for %s", (kind) => {
    expect(resolveChatThreadId(null, { kind })).toBeNull();
  });
});
