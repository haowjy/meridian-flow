/**
 * Subagent snapshots resolve parent by id, not from a primary list.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./adapters/in-memory/repositories.js";
import type { ThreadEventHub } from "./thread-event-hub.js";
import { buildThreadSnapshot } from "./thread-snapshot.js";

function stubHub(): ThreadEventHub {
  return {
    async headSeq() {
      return 0n;
    },
    async readModelProjectionWatermark() {
      return 0n;
    },
  } as unknown as ThreadEventHub;
}

describe("buildThreadSnapshot parent", () => {
  it("loads a nested subagent parent by id", async () => {
    const repos = createInMemoryRepositories();
    const parent = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
      title: "Muse chat",
    });
    const child = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: parent.id as ThreadId,
      rootThreadId: parent.id as ThreadId,
      spawnDepth: 1,
      title: "Critic",
    });
    const nested = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: child.id as ThreadId,
      rootThreadId: parent.id as ThreadId,
      spawnDepth: 2,
      title: "Helper",
    });

    const snapshot = await buildThreadSnapshot(
      repos,
      stubHub(),
      { getRunningTurnId: () => null },
      { read: async () => ({ kind: "asleep" as const }) },
      nested.id as ThreadId,
    );

    expect(snapshot.parent).toEqual({ id: child.id, title: "Critic" });
  });
});
