// @ts-nocheck
import type { ThreadListItem, Work } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { groupProjectThreads, groupThreadsByDate } from "./dashboard-data";

const projectId = "00000000-0000-4000-8000-000000000000";

function thread(id: string, patch: Partial<ThreadListItem> = {}): ThreadListItem {
  return {
    id,
    projectId,
    workId: null,
    userId: "user_1",
    kind: "primary",
    status: "idle",
    title: id,
    currentAgent: null,
    parentThreadId: null,
    rootThreadId: id,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    work: null,
    waitingForUser: false,
    runningTurnId: null,
    ...patch,
  };
}

function work(id: string): Work {
  return {
    id,
    projectId,
    title: id,
    description: null,
    status: "active",
    visibility: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("groupProjectThreads", () => {
  it("does not fabricate ungrouped threads while works are loading", () => {
    const groups = groupProjectThreads([thread("t1", { workId: "w1" })], null);

    expect(groups.primaryThreads.map((t) => t.id)).toEqual(["t1"]);
    expect(groups.workItems).toEqual([]);
    expect(groups.ungroupedThreads).toEqual([]);
  });

  it("marks unresolved primary threads ungrouped once works have loaded", () => {
    const groups = groupProjectThreads([thread("t1", { workId: "missing" })], []);

    expect(groups.ungroupedThreads.map((t) => t.id)).toEqual(["t1"]);
  });

  it("groups primary threads when their work has loaded", () => {
    const groups = groupProjectThreads([thread("t1", { workId: "w1" })], [work("w1")]);

    expect(groups.workItems).toMatchObject([{ id: "w1", threadIds: ["t1"] }]);
    expect(groups.ungroupedThreads).toEqual([]);
  });

  it("counts subagents consistently in work progress", () => {
    const groups = groupProjectThreads(
      [
        thread("parent", { workId: "w1", status: "active" }),
        thread("sub-done", {
          kind: "subagent",
          parentThreadId: "parent",
          rootThreadId: "parent",
          spawnDepth: 1,
        }),
        thread("sub-active", {
          kind: "subagent",
          parentThreadId: "parent",
          rootThreadId: "parent",
          spawnDepth: 1,
          status: "active",
        }),
      ],
      [work("w1")],
    );

    expect(groups.workItems[0]).toMatchObject({ completedCount: 1, totalCount: 3 });
  });

  it("treats threads with a runningTurnId as not-yet-done in progress", () => {
    const groups = groupProjectThreads(
      [
        thread("parent", { workId: "w1", status: "idle", runningTurnId: "turn_1" }),
        thread("sib", { workId: "w1", status: "idle" }),
      ],
      [work("w1")],
    );

    // running thread (parent) should not count as complete, sib does (idle)
    expect(groups.workItems[0]).toMatchObject({ completedCount: 1, totalCount: 2 });
  });
});

describe("groupThreadsByDate", () => {
  it("buckets threads by local calendar recency and keeps newest first", () => {
    const now = Date.parse("2026-06-07T12:00:00.000Z");
    const buckets = groupThreadsByDate(
      [
        thread("earlier", { updatedAt: "2026-05-20T12:00:00.000Z" }),
        thread("today-old", { updatedAt: "2026-06-07T09:00:00.000Z" }),
        thread("previous-7", { updatedAt: "2026-06-03T12:00:00.000Z" }),
        thread("today-new", { updatedAt: "2026-06-07T11:00:00.000Z" }),
        thread("yesterday", { updatedAt: "2026-06-06T12:00:00.000Z" }),
      ],
      now,
    );

    expect(buckets).toEqual([
      { id: "today", threadIds: ["today-new", "today-old"] },
      { id: "yesterday", threadIds: ["yesterday"] },
      { id: "previous7", threadIds: ["previous-7"] },
      { id: "earlier", threadIds: ["earlier"] },
    ]);
  });
});
