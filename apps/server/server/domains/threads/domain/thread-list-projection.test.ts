/** Thread list projection denormalizes row state for project/sidebar lists. */
import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { toThreadListItem } from "./thread-list-projection.js";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    workId: null,
    userId: "user-1",
    kind: "primary",
    status: "idle",
    title: "Draft review",
    currentAgent: null,
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: "thread-1",
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("toThreadListItem", () => {
  it("projects actionRequired from a pending ask_user interrupt", () => {
    const row = toThreadListItem({
      thread: thread(),
      workTitle: null,
      lastTurnRole: "assistant",
      lastTurnStatus: "waiting_interrupt",
      lastTurnAt: "2026-01-01T00:01:00.000Z",
      lastOpenedAt: null,
      runningTurnId: null,
    });

    expect(row).toMatchObject({
      id: "thread-1",
      attention: "actionRequired",
      runningTurnId: null,
    });
  });

  it("projects unread when a completed assistant reply is newer than last opened", () => {
    const row = toThreadListItem({
      thread: thread(),
      workTitle: null,
      lastTurnRole: "assistant",
      lastTurnStatus: "complete",
      lastTurnAt: "2026-01-01T00:02:00.000Z",
      lastOpenedAt: "2026-01-01T00:01:00.000Z",
      runningTurnId: null,
    });
    expect(row.attention).toBe("unread");
  });

  it("projects none after the writer opens the completed reply", () => {
    const row = toThreadListItem({
      thread: thread(),
      workTitle: null,
      lastTurnRole: "assistant",
      lastTurnStatus: "complete",
      lastTurnAt: "2026-01-01T00:02:00.000Z",
      lastOpenedAt: "2026-01-01T00:02:00.000Z",
      runningTurnId: null,
    });
    expect(row.attention).toBe("none");
  });
});
