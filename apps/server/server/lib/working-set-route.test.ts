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
  availabilityKind?: "available" | "not-visible";
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
    projectContextAvailability: {
      lookup: vi.fn().mockImplementation(({ projectId, documentIds }) =>
        Promise.resolve({
          projectId,
          resolutionId: "lookup-1",
          resolutions: documentIds.map((documentId: string) =>
            input?.availabilityKind === "available"
              ? {
                  kind: "available",
                  documentId,
                  generation: "1",
                  authority: { kind: "project", projectId },
                  entry: {},
                }
              : { kind: "not-visible", documentId, checkedGeneration: "1" },
          ),
        }),
      ),
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

  it("rejects malformed thread and work UUIDs at the parse boundary", () => {
    expectBadRequest(() =>
      parsePutWorkingSetRequest({ recentRoutes: [], lastThreadId: "missing" }),
    );
    expectBadRequest(() =>
      parsePutWorkingSetRequest({
        recentRoutes: [{ scheme: "scratch", path: "/a", workId: "work-1" }],
        lastThreadId: null,
      }),
    );
  });

  it("rejects locator-only routes and validates stable identities through project availability", async () => {
    expectBadRequest(() =>
      parsePutWorkingSetRequest({
        recentRoutes: [{ scheme: "kb", path: "/a" }],
        lastThreadId: null,
      }),
    );
    const documentId = "00000000-0000-0000-0000-000000000001";
    const body = parsePutWorkingSetRequest({
      recentRoutes: [{ documentId, scheme: "kb", path: "/a" }],
      lastThreadId: null,
    });
    const unavailable = dependencies();
    await expect(
      handlePutWorkingSetRequest(unavailable, {
        userId: "user-1",
        projectId: "project-1",
        body,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(unavailable.projectContextAvailability.lookup).toHaveBeenCalledWith(
      { projectId: "project-1", documentIds: [documentId] },
      { userId: "user-1" },
    );

    await expect(
      handlePutWorkingSetRequest(dependencies({ availabilityKind: "available" }), {
        userId: "user-1",
        projectId: "project-1",
        body,
      }),
    ).resolves.toEqual({ revision: 1 });
  });

  it("accepts explicit no-Work authority without consulting the Work repository", async () => {
    const documentId = "00000000-0000-0000-0000-000000000001";
    const deps = dependencies({ availabilityKind: "available" });
    const body = parsePutWorkingSetRequest({
      recentRoutes: [{ documentId, scheme: "scratch", path: "/notes.md", workId: null }],
      lastThreadId: null,
    });
    await expect(
      handlePutWorkingSetRequest(deps, {
        userId: "user-1",
        projectId: "project-1",
        body,
      }),
    ).resolves.toEqual({ revision: 1 });
    expect(deps.works.findById).not.toHaveBeenCalled();
  });

  it("rejects work and thread references outside the project", async () => {
    await expect(
      handlePutWorkingSetRequest(dependencies({ work: { id: "work-2", projectId: "project-2" } }), {
        userId: "user-1",
        projectId: "project-1",
        body: {
          recentRoutes: [
            {
              documentId: "00000000-0000-0000-0000-000000000001",
              scheme: "scratch",
              path: "/a",
              workId: "work-2",
            },
          ],
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
