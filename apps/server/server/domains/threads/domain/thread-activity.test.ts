/**
 * Pure projection contract for the thread activity read: direct child rows plus a
 * live-lease map become the ordered activity tree, absent lease means asleep.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadLeaseState } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type { ThreadChild } from "../ports/index.js";
import { projectThreadActivity, readThreadActivity } from "./thread-activity.js";

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

function lease(status: ThreadLeaseState["status"]): ThreadLeaseState {
  return { status, runningTurnId: null };
}

describe("projectThreadActivity", () => {
  it("preserves child order and defaults an absent lease to asleep", () => {
    const activity = projectThreadActivity(
      [
        child({ id: "child-1", parentThreadId: "root-1" }),
        child({ id: "child-2", parentThreadId: "root-1" }),
      ],
      new Map(),
    );

    expect(activity.children.map((node) => node.threadId)).toEqual(["child-1", "child-2"]);
    expect(activity.children.every((node) => node.status.kind === "asleep")).toBe(true);
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
        child({
          id: "child-1",
          parentThreadId: "root-1",
          title: "Review the chapter",
          agentName: "Critic",
          ref: "p3",
          originTurnId: "turn-9",
        }),
      ],
      leases,
    );

    expect(activity.children[0]).toEqual({
      threadId: "child-1",
      parentThreadId: "root-1",
      ref: "p3",
      title: "Review the chapter",
      agentName: "Critic",
      spawnStatus: "running",
      status: { kind: "awake", phase: "generating", cancelRequested: false },
      originTurnId: "turn-9",
    });
  });
});

describe("readThreadActivity", () => {
  it("reads and projects the direct children only", async () => {
    const childRows = [child({ id: "child-1", parentThreadId: "parent" })];
    let readThreadId: ThreadId | undefined;
    const activity = await readThreadActivity(
      {
        threads: {
          async listChildren(threadId) {
            readThreadId = threadId;
            return childRows;
          },
        },
        statusReader: {
          async readMany(ids) {
            expect(ids).toEqual(["child-1"]);
            return new Map();
          },
        },
      },
      "parent" as ThreadId,
    );

    expect(readThreadId).toBe("parent");
    expect(activity.children).toEqual([
      {
        threadId: "child-1",
        parentThreadId: "parent",
        ref: null,
        title: null,
        agentName: null,
        spawnStatus: "running",
        status: { kind: "asleep" },
        originTurnId: null,
      },
    ]);
    expect(activity.children[0]).not.toHaveProperty("depth");
    expect(activity.children[0]).not.toHaveProperty("rootThreadId");
  });
});
