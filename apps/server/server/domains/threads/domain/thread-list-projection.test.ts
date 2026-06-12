import type { Thread, ThreadListItem } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { summarizeThreadList, toThreadListItem } from "./thread-list-projection.js";

function thread(overrides: Partial<Thread> = {}): Thread {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    workbenchId: "workbench-1",
    workId: null,
    userId: "user-1",
    kind: "primary",
    status: "idle",
    title: null,
    systemPrompt: null,
    workingState: null,
    currentAgent: null,
    nextSeq: "0",
    parentThreadId: null,
    rootThreadId: overrides.rootThreadId ?? id,
    spawnDepth: 0,
    spawnStatus: null,
    spawnResult: null,
    totalCostUsd: "0",
    turnCount: 0,
    historySummary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function listItem(overrides: Partial<ThreadListItem> = {}): ThreadListItem {
  return {
    ...thread(overrides),
    work: null,
    waitingForUser: false,
    runningTurnId: null,
    ...overrides,
  };
}

describe("thread-list-projection", () => {
  it("derives waitingForUser for idle threads whose latest turn is a complete assistant turn", () => {
    expect(
      toThreadListItem({
        thread: thread(),
        workTitle: null,
        lastTurnRole: "assistant",
        lastTurnStatus: "complete",
        runningTurnId: null,
      }).waitingForUser,
    ).toBe(true);
  });

  it("summarizes thread lifecycle counts", () => {
    expect(
      summarizeThreadList([
        listItem({ runningTurnId: "turn-running", status: "active", waitingForUser: true }),
        listItem({ waitingForUser: true }),
        listItem({ status: "idle" }),
        listItem({ status: "error" }),
      ]),
    ).toEqual({ running: 1, waiting: 1, idle: 1, totalThreads: 4 });
  });
});
