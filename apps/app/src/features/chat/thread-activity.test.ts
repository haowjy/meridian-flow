/**
 * The running-subagents view derives from the viewed thread's own subtree. These
 * pin the re-basing (a root frame filtered to a child view) and the lease-backed
 * active filter — no primary special case.
 */
import type { ThreadActivity, ThreadActivityNode } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { activeDescendants, isActiveNode, subtreeOf } from "./thread-activity";

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
  it("keeps only nodes with a live lease", () => {
    const nodes = [
      node({
        threadId: "live",
        status: { kind: "awake", phase: "generating", cancelRequested: false },
      }),
      // A durable `running` with no live lease is the dead-process case: the row
      // reads Asleep, so the strip must not count it.
      node({ threadId: "dead-process", spawnStatus: "running" }),
      node({ threadId: "done", spawnStatus: "succeeded" }),
    ];
    expect(nodes.map(isActiveNode)).toEqual([true, false, false]);
    expect(activeDescendants({ descendants: nodes }).map((n) => n.threadId)).toEqual(["live"]);
  });
});
