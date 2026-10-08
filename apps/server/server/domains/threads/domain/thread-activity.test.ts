/**
 * Pure projection contract for the thread activity read: direct child rows plus a
 * live-lease map become the ordered activity tree, absent lease means asleep.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { ThreadChild } from "../ports/index.js";
import { projectThreadActivity } from "./thread-activity.js";

function child(overrides: Partial<ThreadChild> & { id: string }): ThreadChild {
  return {
    parentThreadId: null,
    ref: null,
    title: null,
    agentName: null,
    spawnStatus: "running",
    originTurnId: null,
    ...overrides,
  };
}

describe("projectThreadActivity", () => {
  it("treats an admitted run without a delivery invocation as background activity", () => {
    const activity = projectThreadActivity(
      [child({ id: "child-1" })],
      new Map(),
      new Map([
        [
          "child-1" as ThreadId,
          {
            childThreadId: "child-1" as ThreadId,
            deliveryMode: "none",
            callerThreadId: null,
            admittedAt: "2026-09-26T10:00:00.000Z",
            terminalAt: null,
          },
        ],
      ]),
    );

    expect(activity.children[0]?.deliveryMode).toBe("background_notification");
  });
});
