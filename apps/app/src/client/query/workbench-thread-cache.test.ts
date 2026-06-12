/**
 * workbench-thread-cache tests — guards cache reconciliation for denormalized
 * thread-list lifecycle fields derived from authoritative snapshots.
 */

import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { workbenchQueryKeys } from "./workbench-query-keys";
import { readProjectThreadList, upsertThreadInProject } from "./workbench-thread-cache";

const PROJECT_ID = "00000000-0000-4000-8000-000000000000";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread_1",
    workbenchId: PROJECT_ID,
    workId: null,
    userId: "user_1",
    kind: "primary",
    status: "idle",
    title: "Thread",
    currentAgent: null,
    parentThreadId: null,
    rootThreadId: overrides.rootThreadId ?? overrides.id ?? "thread_1",
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

function listItem(overrides: Partial<ThreadListItem> = {}): ThreadListItem {
  return {
    ...thread(overrides),
    work: null,
    waitingForUser: false,
    runningTurnId: null,
    ...overrides,
  };
}

describe("upsertThreadInProject", () => {
  it("clears stale lifecycle fields when an idle snapshot is applied", () => {
    const client = new QueryClient();
    client.setQueryData(workbenchQueryKeys.threads(PROJECT_ID), [
      listItem({ status: "active", runningTurnId: "turn_running", waitingForUser: true }),
    ]);

    upsertThreadInProject(client, thread({ status: "idle" }), {
      runningTurnId: null,
      waitingForUser: false,
    });

    expect(readProjectThreadList(client, PROJECT_ID)).toEqual([
      expect.objectContaining({
        id: "thread_1",
        status: "idle",
        runningTurnId: null,
        waitingForUser: false,
      }),
    ]);
  });

  it("uses snapshot lifecycle fields for new list rows", () => {
    const client = new QueryClient();

    upsertThreadInProject(client, thread({ status: "active" }), {
      runningTurnId: "turn_running",
      waitingForUser: false,
    });

    expect(readProjectThreadList(client, PROJECT_ID)?.[0]).toEqual(
      expect.objectContaining({
        id: "thread_1",
        runningTurnId: "turn_running",
        waitingForUser: false,
      }),
    );
  });
});
