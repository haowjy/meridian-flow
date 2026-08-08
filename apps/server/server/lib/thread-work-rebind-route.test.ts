/** Writer HTTP adapter coverage for thread Work rebind. */

import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import {
  handleRebindThreadWorkRequest,
  parseRebindThreadWorkRequest,
} from "./thread-work-rebind-route.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000201" as ThreadId;
const SOURCE_ID = "00000000-0000-4000-8000-000000000202" as WorkId;
const TARGET_ID = "00000000-0000-4000-8000-000000000203" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000204" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-000000000205" as ProjectId;

function routeFixture(
  options: {
    running?: boolean;
    targetProjectId?: ProjectId;
    deletedTarget?: boolean;
    owner?: UserId;
    sameTarget?: boolean;
    flushFailure?: boolean;
  } = {},
) {
  const thread = {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    userId: options.owner ?? USER_ID,
    kind: "primary",
    deletedAt: null,
  } as Thread;
  const project = {
    id: PROJECT_ID,
    userId: options.owner ?? USER_ID,
    deletedAt: null,
  } as Project;
  const makeWork = (id: WorkId, name: string, projectId = PROJECT_ID) =>
    ({
      id,
      projectId,
      createdByUserId: USER_ID,
      name,
      slug: name.toLowerCase(),
      goal: null,
      description: null,
      status: "active",
      archivedAt: null,
      aiWriteMode: "direct",
      createdAt: "now",
      updatedAt: "now",
      lastActivityAt: "now",
      deletedAt: null,
    }) as Work;
  const source = makeWork(SOURCE_ID, "Source");
  const target = {
    ...makeWork(TARGET_ID, "Target", options.targetProjectId),
    deletedAt: options.deletedTarget ? "now" : null,
  };
  let current = options.sameTarget ? TARGET_ID : SOURCE_ID;
  let pending = false;
  return {
    deps: {
      threads: { findById: async () => thread },
      projects: { findById: async () => project },
      works: {
        findById: async (id: WorkId) =>
          id === SOURCE_ID ? source : id === TARGET_ID ? target : null,
      },
      threadWorks: {
        rebindPrimary: async (_threadId: ThreadId, workId: WorkId) => {
          const previousWorkId = current;
          current = workId;
          return { previousWorkId, changed: previousWorkId !== workId };
        },
      },
      preferences: { setCurrentWorkId: vi.fn(async () => {}) },
      contextUpdates: {
        threadChanged: async () => {
          pending = true;
        },
        flush: async () => {
          if (options.flushFailure) throw new Error("delivery unavailable");
          pending = false;
        },
        isPending: async () => pending,
      },
      transaction: async <T>(operation: () => Promise<T>) => operation(),
      isThreadRunning: () => options.running ?? false,
    },
  };
}

describe("thread Work rebind writer adapter", () => {
  it("parses only strict canonical {workId} bodies", () => {
    expect(parseRebindThreadWorkRequest({ workId: TARGET_ID })).toEqual({ workId: TARGET_ID });
    expect(() => parseRebindThreadWorkRequest({ workId: TARGET_ID, extra: true })).toThrow();
    expect(() => parseRebindThreadWorkRequest({})).toThrow();
    expect(() => parseRebindThreadWorkRequest({ workId: "target" })).toThrow();
  });

  it("returns a retryable structured busy conflict without mutating", async () => {
    const h = routeFixture({ running: true });
    await expect(
      handleRebindThreadWorkRequest(h.deps as never, {
        threadId: THREAD_ID,
        userId: USER_ID,
        body: { workId: TARGET_ID },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { code: "thread_busy", retryable: true },
    });
    expect(h.deps.preferences.setCurrentWorkId).not.toHaveBeenCalled();
  });

  it("returns the shared receipt and truthful delivery status", async () => {
    const h = routeFixture({ flushFailure: true });
    await expect(
      handleRebindThreadWorkRequest(h.deps as never, {
        threadId: THREAD_ID,
        userId: USER_ID,
        body: { workId: TARGET_ID },
      }),
    ).resolves.toMatchObject({
      changed: true,
      contextUpdate: "pending",
      receipt: {
        operation: "switch",
        before: { name: "Source" },
        after: { name: "Target" },
        inverse: { command: "switch", workId: SOURCE_ID },
      },
    });
  });

  it("returns changed false for an idle same-target retry", async () => {
    const h = routeFixture({ sameTarget: true });
    await expect(
      handleRebindThreadWorkRequest(h.deps as never, {
        threadId: THREAD_ID,
        userId: USER_ID,
        body: { workId: TARGET_ID },
      }),
    ).resolves.toMatchObject({
      changed: false,
      preferenceChanged: false,
      contextUpdate: "not_required",
      receipt: { inverse: null },
    });
    expect(h.deps.preferences.setCurrentWorkId).not.toHaveBeenCalled();
  });

  it("conceals wrong-owner, cross-project, and deleted targets", async () => {
    const cases = [
      routeFixture({ owner: "00000000-0000-4000-8000-000000000299" as UserId }),
      routeFixture({ targetProjectId: "00000000-0000-4000-8000-000000000298" as ProjectId }),
      routeFixture({ deletedTarget: true }),
      {
        ...routeFixture(),
        deps: { ...routeFixture().deps, works: { findById: async () => null } },
      },
    ];
    for (const h of cases) {
      await expect(
        handleRebindThreadWorkRequest(h.deps as never, {
          threadId: THREAD_ID,
          userId: USER_ID,
          body: { workId: TARGET_ID },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  });
});
