// @ts-nocheck
import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { lifecycleFor, lifecycleFromHints, lifecycleFromStatus } from "./lifecycle";

function baseThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    workbenchId: "p1",
    workId: null,
    userId: "u1",
    kind: "primary",
    status: "idle",
    title: "Hello",
    currentAgent: null,
    parentThreadId: null,
    rootThreadId: overrides.rootThreadId ?? overrides.id ?? "t1",
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function listItem(overrides: Partial<ThreadListItem> = {}): ThreadListItem {
  const base = baseThread(overrides);
  return {
    ...base,
    work: null,
    waitingForUser: false,
    runningTurnId: null,
    ...overrides,
  };
}

describe("lifecycleFromStatus", () => {
  it("maps raw thread.status to a presentation state", () => {
    expect(lifecycleFromStatus("active")).toBe("executing");
    expect(lifecycleFromStatus("blocked")).toBe("checkpoint");
    expect(lifecycleFromStatus("idle")).toBe("idle");
    expect(lifecycleFromStatus("error")).toBe("errored");
    expect(lifecycleFromStatus("archived")).toBe("idle");
  });
});

describe("lifecycleFromHints", () => {
  it("treats a live runningTurnId as executing even if status lags", () => {
    expect(lifecycleFromHints({ status: "idle", runningTurnId: "turn_1" })).toBe("executing");
  });

  it("uses waitingForUser only when no turn is running", () => {
    expect(lifecycleFromHints({ status: "idle", waitingForUser: true })).toBe("waiting");
    expect(
      lifecycleFromHints({ status: "idle", waitingForUser: true, runningTurnId: "turn_1" }),
    ).toBe("executing");
  });

  it("falls back to status when no row hints", () => {
    expect(lifecycleFromHints({ status: "active" })).toBe("executing");
    expect(lifecycleFromHints({ status: "blocked" })).toBe("checkpoint");
    expect(lifecycleFromHints({ status: "idle" })).toBe("idle");
  });
});

describe("lifecycleFor", () => {
  it("derives executing from a list item with a live runningTurnId", () => {
    const t = listItem({ status: "active", runningTurnId: "turn_42" });
    expect(lifecycleFor(t)).toBe("executing");
  });

  it("derives waiting from a list item with waitingForUser=true and no run", () => {
    const t = listItem({ status: "idle", waitingForUser: true });
    expect(lifecycleFor(t)).toBe("waiting");
  });

  it("derives idle from a list item with neither", () => {
    const t = listItem({ status: "idle" });
    expect(lifecycleFor(t)).toBe("idle");
  });

  it("works for a base Thread without row projection hints", () => {
    expect(lifecycleFor(baseThread({ status: "active" }))).toBe("executing");
    expect(lifecycleFor(baseThread({ status: "blocked" }))).toBe("checkpoint");
    expect(lifecycleFor(baseThread({ status: "idle" }))).toBe("idle");
  });
});
