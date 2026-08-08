/** Writer HTTP adapter coverage for thread Work rebind. */

import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { WorkLifecycleUnavailableError } from "../domains/projects/index.js";
import interruptErrorHandler from "./interrupt-error-handler.js";
import {
  handleRebindThreadWorkRequest,
  parseRebindThreadWorkRequest,
  type ThreadWorkRebindRouteDeps,
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
    rebindFailure?: Error;
    missingPrimary?: boolean;
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
          if (options.rebindFailure) throw options.rebindFailure;
          const previousWorkId = current;
          current = workId;
          return {
            previousWorkId: options.missingPrimary ? null : previousWorkId,
            changed: previousWorkId !== workId,
          };
        },
      },
      preferences: { setCurrentWorkId: vi.fn(async () => {}) },
      obligations: {
        enqueueThread: async () => {
          return [THREAD_ID];
        },
      },
      workContextDelivery: {
        deliverAfterCommit: async () => {
          if (options.flushFailure) return "pending" as const;
          return "delivered" as const;
        },
      },
      transaction: async <T>(operation: () => Promise<T>) => operation(),
      runOwnership: {
        tryAcquire: async () => (options.running ? null : { release: vi.fn(async () => {}) }),
      },
    } satisfies ThreadWorkRebindRouteDeps,
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
      handleRebindThreadWorkRequest(h.deps, {
        threadId: THREAD_ID,
        userId: USER_ID,
        body: { workId: TARGET_ID },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: {
        __meridianInterruptEnvelope: {
          kind: "error",
          error: { code: "thread_busy", source: "system", retryable: true },
        },
      },
    });
    expect(h.deps.preferences.setCurrentWorkId).not.toHaveBeenCalled();
  });

  it("holds the run claim across the transaction and releases before delivery", async () => {
    const h = routeFixture();
    let claimed = false;
    const order: string[] = [];
    const runOwnership = {
      async tryAcquire() {
        if (claimed) return null;
        claimed = true;
        order.push("claim");
        return {
          async release() {
            claimed = false;
            order.push("release");
          },
        };
      },
    };
    const transaction = async <T>(operation: () => Promise<T>) => {
      order.push("transaction");
      expect(await runOwnership.tryAcquire()).toBeNull();
      return operation();
    };
    const originalDelivery = h.deps.workContextDelivery.deliverAfterCommit;
    h.deps.workContextDelivery.deliverAfterCommit = async () => {
      expect(claimed).toBe(false);
      order.push("delivery");
      return originalDelivery();
    };

    await handleRebindThreadWorkRequest(
      { ...h.deps, runOwnership, transaction },
      {
        threadId: THREAD_ID,
        userId: USER_ID,
        body: { workId: TARGET_ID },
      },
    );

    expect(order).toEqual(["claim", "transaction", "release", "delivery"]);
  });

  it("returns the shared receipt and truthful delivery status", async () => {
    const h = routeFixture({ flushFailure: true });
    await expect(
      handleRebindThreadWorkRequest(h.deps, {
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
      handleRebindThreadWorkRequest(h.deps, {
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
        handleRebindThreadWorkRequest(h.deps, {
          threadId: THREAD_ID,
          userId: USER_ID,
          body: { workId: TARGET_ID },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it("serializes structured conflicts through the canonical HTTP envelope", async () => {
    const cases = [
      {
        fixture: routeFixture({ deletedTarget: true }),
        status: 404,
        code: "not_found",
      },
      {
        fixture: routeFixture({ running: true }),
        status: 409,
        code: "thread_busy",
      },
      {
        fixture: routeFixture({ missingPrimary: true }),
        status: 409,
        code: "thread_work_missing",
      },
      {
        fixture: routeFixture({
          rebindFailure: new WorkLifecycleUnavailableError(TARGET_ID, "deleted"),
        }),
        status: 409,
        code: "work_unavailable",
        details: { refresh: "works" },
      },
    ];

    for (const entry of cases) {
      let thrown: unknown;
      try {
        await handleRebindThreadWorkRequest(entry.fixture.deps, {
          threadId: THREAD_ID,
          userId: USER_ID,
          body: { workId: TARGET_ID },
        });
      } catch (cause) {
        thrown = cause;
      }
      const response = interruptErrorHandler(thrown, {});
      expect(response?.status).toBe(entry.status);
      await expect(response?.json()).resolves.toMatchObject({
        kind: "error",
        error: {
          code: entry.code,
          source: "system",
          ...(entry.details ? { details: entry.details } : {}),
        },
      });
    }
  });

  it("does not conceal arbitrary database failures", async () => {
    const failure = new Error("database connection lost");
    const h = routeFixture({ rebindFailure: failure });
    await expect(
      handleRebindThreadWorkRequest(h.deps, {
        threadId: THREAD_ID,
        userId: USER_ID,
        body: { workId: TARGET_ID },
      }),
    ).rejects.toBe(failure);
  });
});
