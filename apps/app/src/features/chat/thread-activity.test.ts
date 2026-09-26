import type { ThreadActivityNode, ThreadStatus } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  activeChildren,
  EMPTY_THREAD_ACTIVITY,
  isActiveNode,
  isThreadActivity,
} from "./thread-activity";

const AWAKE: ThreadStatus = { kind: "awake", phase: "generating", cancelRequested: false };

function node(overrides: Partial<ThreadActivityNode> & { threadId: string }): ThreadActivityNode {
  return {
    parentThreadId: "thread-1",
    ref: null,
    title: null,
    agentName: null,
    spawnStatus: "running",
    status: AWAKE,
    originTurnId: null,
    ...overrides,
  };
}

describe("thread activity", () => {
  it("uses the children shape for empty activity and frame validation", () => {
    expect(EMPTY_THREAD_ACTIVITY).toEqual({ children: [] });
    expect(isThreadActivity({ children: [] })).toBe(true);
    expect(isThreadActivity({ items: [] })).toBe(false);
    expect(isThreadActivity(null)).toBe(false);
  });

  it("selects only active direct children", () => {
    const nodes = [
      node({ threadId: "live" }),
      node({ threadId: "waiting", status: { kind: "asleep" } }),
    ];
    expect(nodes.map(isActiveNode)).toEqual([true, false]);
    expect(activeChildren({ children: nodes }).map((child) => child.threadId)).toEqual(["live"]);
  });
});
