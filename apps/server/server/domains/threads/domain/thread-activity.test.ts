/**
 * Pure projection contract for the thread activity read: descendant rows plus a
 * live-lease map become the ordered activity tree, absent lease means asleep.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadLeaseState } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type { LatestChildExecution, ThreadDescendant } from "../ports/index.js";
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
  return { status, runningTurnId: null, currentTool: null };
}

describe("projectThreadActivity", () => {
  it("preserves descendant order and defaults an absent lease to asleep", () => {
    const activity = projectThreadActivity(
      [
        descendant({ id: "child-1", spawnDepth: 1 }),
        descendant({ id: "child-2", spawnDepth: 2, parentThreadId: "child-1" }),
      ],
      new Map(),
      new Map(),
    );

    expect(activity.descendants.map((node) => node.threadId)).toEqual(["child-1", "child-2"]);
    expect(activity.descendants.every((node) => node.status.kind === "asleep")).toBe(true);
    expect(activity.descendants.every((node) => node.deliveryMode === null)).toBe(true);
  });

  it("derives status from the live lease and carries the row fields", () => {
    const leases = new Map<ThreadId, ThreadLeaseState>([
      [
        "child-1" as ThreadId,
        {
          ...lease({ kind: "awake", phase: "generating", cancelRequested: false }),
          currentTool: {
            toolCallId: "call-7",
            toolName: "spawn",
            input: { agent: "researcher", prompt: "Find evidence" },
          },
        },
      ],
    ]);
    const latestRuns = new Map<ThreadId, LatestChildExecution>([
      [
        "child-1" as ThreadId,
        {
          childThreadId: "child-1" as ThreadId,
          deliveryMode: "direct",
          admittedAt: "2026-09-26T10:00:00.000Z",
          terminalAt: null,
        },
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
      latestRuns,
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
      deliveryMode: "direct",
      runStartedAt: "2026-09-26T10:00:00.000Z",
      runEndedAt: null,
      currentTool: {
        toolCallId: "call-7",
        toolName: "spawn",
        input: { agent: "researcher", prompt: "Find evidence" },
      },
      originTurnId: "turn-9",
    });
  });

  it("treats an admitted run without a delivery invocation as background activity", () => {
    const activity = projectThreadActivity(
      [descendant({ id: "child-1" })],
      new Map(),
      new Map([
        [
          "child-1" as ThreadId,
          {
            childThreadId: "child-1" as ThreadId,
            deliveryMode: "none",
            admittedAt: "2026-09-26T10:00:00.000Z",
            terminalAt: null,
          },
        ],
      ]),
    );

    expect(activity.descendants[0]?.deliveryMode).toBe("background_notification");
  });
});
