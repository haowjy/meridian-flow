/**
 * The running-subagents view derives from the viewed thread's own subtree. These
 * pin the re-basing (a root frame filtered to a child view), the active filter,
 * and the status label mapping — no primary special case.
 */
import type { ThreadActivity, ThreadActivityNode } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { activeDescendants, isActiveNode, subtreeOf, threadStatusText } from "./thread-activity";

function node(overrides: Partial<ThreadActivityNode> & { threadId: string }): ThreadActivityNode {
  return {
    parentThreadId: null,
    rootThreadId: "root",
    depth: 1,
    ref: null,
    title: null,
    agentName: null,
    spawnStatus: null,
    status: { kind: "asleep" },
    originTurnId: null,
    ...overrides,
  };
}

const activity: ThreadActivity = {
  descendants: [
    node({ threadId: "a", parentThreadId: "root", depth: 1 }),
    node({ threadId: "b", parentThreadId: "root", depth: 1 }),
    node({ threadId: "a1", parentThreadId: "a", depth: 2 }),
  ],
};

describe("subtreeOf", () => {
  it("keeps the whole tree for the root view in source order", () => {
    expect(subtreeOf(activity, "root").descendants.map((n) => n.threadId)).toEqual([
      "a",
      "b",
      "a1",
    ]);
  });

  it("re-bases to a child view without its siblings or parents", () => {
    expect(subtreeOf(activity, "a").descendants.map((n) => n.threadId)).toEqual(["a1"]);
  });

  it("is empty for a leaf", () => {
    expect(subtreeOf(activity, "a1").descendants).toEqual([]);
  });
});

describe("active descendants", () => {
  it("keeps a live process and an unsettled spawn", () => {
    const nodes = [
      node({
        threadId: "live",
        status: { kind: "awake", phase: "generating", cancelRequested: false },
      }),
      node({ threadId: "spawning", spawnStatus: "running" }),
      node({ threadId: "done", spawnStatus: "succeeded" }),
    ];
    expect(nodes.map(isActiveNode)).toEqual([true, true, false]);
    expect(activeDescendants({ descendants: nodes }).map((n) => n.threadId)).toEqual([
      "live",
      "spawning",
    ]);
  });
});

describe("threadStatusText", () => {
  it("names each derived status", () => {
    expect(threadStatusText({ kind: "asleep" })).toBe("asleep");
    expect(threadStatusText({ kind: "awake", phase: "generating", cancelRequested: false })).toBe(
      "generating",
    );
    expect(threadStatusText({ kind: "awake", phase: "waiting", cancelRequested: false })).toBe(
      "waiting",
    );
  });
});
