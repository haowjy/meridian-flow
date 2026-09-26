/**
 * Pure projection contract for the thread activity read: descendant rows plus a
 * live-lease map become the ordered activity tree, absent lease means asleep.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadLeaseState } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type { ThreadDescendant } from "../ports/index.js";
import { projectThreadActivity } from "./thread-activity.js";

function descendant(overrides: Partial<ThreadDescendant> & { id: string }): ThreadDescendant {
  return {
    parentThreadId: null,
    rootThreadId: "root-1",
    spawnDepth: 1,
    ref: null,
    title: null,
    agentName: null,
    spawnStatus: "running",
    originTurnId: null,
    ...overrides,
  };
}

function lease(status: ThreadLeaseState["status"]): ThreadLeaseState {
  return { status, runningTurnId: null };
}

describe("projectThreadActivity", () => {
  it("preserves descendant order and defaults an absent lease to asleep", () => {
    const activity = projectThreadActivity(
      [
        descendant({ id: "child-1", spawnDepth: 1 }),
        descendant({ id: "child-2", spawnDepth: 2, parentThreadId: "child-1" }),
      ],
      new Map(),
    );

    expect(activity.descendants.map((node) => node.threadId)).toEqual(["child-1", "child-2"]);
    expect(activity.descendants.every((node) => node.status.kind === "asleep")).toBe(true);
  });

  it("derives status from the live lease and carries the row fields", () => {
    const leases = new Map<ThreadId, ThreadLeaseState>([
      [
        "child-1" as ThreadId,
        lease({ kind: "awake", phase: "generating", cancelRequested: false }),
      ],
    ]);

    const activity = projectThreadActivity(
      [
        descendant({
          id: "child-1",
          spawnDepth: 2,
          parentThreadId: "root-1",
          title: "Review the chapter",
          agentName: "Critic",
          ref: "p3",
          originTurnId: "turn-9",
        }),
      ],
      leases,
    );

    expect(activity.descendants[0]).toEqual({
      threadId: "child-1",
      parentThreadId: "root-1",
      rootThreadId: "root-1",
      depth: 2,
      ref: "p3",
      title: "Review the chapter",
      agentName: "Critic",
      spawnStatus: "running",
      status: { kind: "awake", phase: "generating", cancelRequested: false },
      originTurnId: "turn-9",
    });
  });
});
