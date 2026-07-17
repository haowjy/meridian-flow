/** Working-set route-core tests cover bounded parsing and project-scoped references. */
import { describe, expect, it, vi } from "vitest";
import type { WorkingSetRouteDeps } from "./working-set-route.js";
import { handlePutWorkingSetRequest, parsePutWorkingSetRequest } from "./working-set-route.js";

function expectBadRequest(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({ statusCode: 400 }));
}

function dependencies(input?: {
  work?: { id: string; projectId: string } | null;
  threadProjectId?: string | null;
}): WorkingSetRouteDeps {
  return {
    projectRepo: {
      findById: vi.fn().mockResolvedValue({
        id: "project-1",
        userId: "user-1",
        deletedAt: null,
      }),
    },
    workingSet: { get: vi.fn(), upsert: vi.fn().mockResolvedValue({ revision: 1 }) },
    works: { findById: vi.fn().mockResolvedValue(input?.work ?? null) },
    threads: {
      findProjectIdByIdIncludingDeleted: vi.fn().mockResolvedValue(input?.threadProjectId ?? null),
    },
  } as unknown as WorkingSetRouteDeps;
}

describe("working-set route core", () => {
  it("rejects oversized lists and invalid route shapes", () => {
    expectBadRequest(() =>
      parsePutWorkingSetRequest({
        recentRoutes: Array.from({ length: 4 }, () => ({ scheme: "kb", path: "/a" })),
        lastThreadId: null,
      }),
    );
    expectBadRequest(() =>
      parsePutWorkingSetRequest({
        recentRoutes: [{ scheme: "scratch", path: "/a" }],
        lastThreadId: null,
      }),
    );
    expectBadRequest(() =>
      parsePutWorkingSetRequest({ recentRoutes: [{ scheme: "kb", path: "" }], lastThreadId: null }),
    );
    expectBadRequest(() =>
      parsePutWorkingSetRequest({
        recentRoutes: [{ scheme: "kb", path: "x".repeat(1025) }],
        lastThreadId: null,
      }),
    );
  });

  it("rejects work and thread references outside the project", async () => {
    await expect(
      handlePutWorkingSetRequest(dependencies({ work: { id: "work-2", projectId: "project-2" } }), {
        userId: "user-1",
        projectId: "project-1",
        body: {
          recentRoutes: [{ scheme: "scratch", path: "/a", workId: "work-2" }],
          lastThreadId: null,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      handlePutWorkingSetRequest(dependencies({ threadProjectId: "project-2" }), {
        userId: "user-1",
        projectId: "project-1",
        body: { recentRoutes: [], lastThreadId: "thread-2" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("accepts a soft-deleted thread owned by the project", async () => {
    const deps = dependencies({ threadProjectId: "project-1" });

    await expect(
      handlePutWorkingSetRequest(deps, {
        userId: "user-1",
        projectId: "project-1",
        body: { recentRoutes: [], lastThreadId: "thread-1" },
      }),
    ).resolves.toEqual({ revision: 1 });
    expect(deps.threads.findProjectIdByIdIncludingDeleted).toHaveBeenCalledWith("thread-1");
  });

  it("rejects unknown thread references and non-owners", async () => {
    await expect(
      handlePutWorkingSetRequest(dependencies(), {
        userId: "user-1",
        projectId: "project-1",
        body: { recentRoutes: [], lastThreadId: "missing" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const deps = dependencies();
    await expect(
      handlePutWorkingSetRequest(deps, {
        userId: "user-2",
        projectId: "project-1",
        body: { recentRoutes: [], lastThreadId: null },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
