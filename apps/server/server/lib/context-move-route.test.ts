/** Writer identity route-core validation, authorization, and authority coverage. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextPort } from "../domains/context/index.js";
import { resolvedWorkAuthority } from "../domains/projects/domain/work-authority.js";
import { testWorkSlug } from "../test-support/work-slug.js";
import { handleContextMoveRequest, parseContextMove } from "./context-move-route.js";

const WORK_ID = "00000000-0000-4000-8000-000000000701";
const OTHER_WORK_ID = "00000000-0000-4000-8000-000000000702";

function body(overrides: Record<string, unknown> = {}) {
  return {
    path: "Source.md",
    destinationScheme: "manuscript",
    destinationFolderPath: "Dest",
    ...overrides,
  };
}

function depsFor(
  options: {
    projectUserId?: string;
    projectDeletedAt?: Date | null;
    works?: Record<string, { projectId: string; deletedAt?: Date | null }>;
  } = {},
) {
  const commitWriterLocation = vi.fn<ContextPort["commitWriterLocation"]>(async () => ({
    ok: true as const,
    value: { movedNodeId: "node-1", destinationPath: "Dest/Source.md" },
  }));
  const port = { commitWriterLocation };
  const resolveById = async (projectId: string, workId: string) => {
    const entries = Object.entries(options.works ?? {}).filter(
      ([, work]) => work.projectId === projectId && !work.deletedAt,
    );
    const index = entries.findIndex(([id]) => id === workId);
    return index < 0
      ? null
      : resolvedWorkAuthority({
          kind: "work",
          workId,
          workSlug: testWorkSlug(`work-${index + 1}`),
        });
  };
  return {
    projectRepo: {
      findById: vi.fn(async () => ({
        id: "project-1",
        userId: options.projectUserId ?? "user-1",
        deletedAt: options.projectDeletedAt ?? null,
      })),
    },
    workRepo: {
      findById: vi.fn(async (id: string) => {
        const work = options.works?.[id];
        return work ? { id, ...work } : null;
      }),
      listByProject: vi.fn(async (projectId: string) =>
        Object.entries(options.works ?? {})
          .filter(([, work]) => work.projectId === projectId && !work.deletedAt)
          .map(([id], index) => ({ id, slug: `work-${index + 1}` })),
      ),
    },
    contextPorts: {
      forProject: vi.fn(() => port),
      forWork: vi.fn(() => port),
    },
    workAuthorityResolver: {
      byId: resolveById,
      lockById: resolveById,
      bySlug: async () => null,
    },
    port,
  };
}

function request(
  deps: ReturnType<typeof depsFor>,
  requestBody = body(),
  sourceScheme = "manuscript",
) {
  return handleContextMoveRequest(deps as never, {
    projectId: "project-1",
    userId: "user-1",
    sourceScheme,
    body: requestBody,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("parseContextMove", () => {
  it("constructs scoped locator variants after normalizing paths", () => {
    expect(
      parseContextMove({
        sourceScheme: "scratch",
        body: body({
          path: " Untitled 1.md ",
          sourceWorkId: WORK_ID,
          destinationFolderPath: " Act 1 ",
        }),
      }),
    ).toEqual({
      source: {
        scope: "work",
        scheme: "scratch",
        workId: WORK_ID,
        path: "Untitled 1.md",
      },
      destination: { scope: "project", scheme: "manuscript", path: "Act 1" },
    });
  });

  it.each([
    ["unknown source scheme", "unknown", body()],
    ["missing destination path", "manuscript", { path: "a.md", destinationScheme: "manuscript" }],
    ["reserved destination", "manuscript", body({ destinationFolderPath: ".." })],
    ["invalid source path", "manuscript", body({ path: "Act 2//a.md" })],
    ["invalid name", "manuscript", body({ newName: "folder/a.md" })],
    ["project source with Work", "manuscript", body({ sourceWorkId: WORK_ID })],
    ["project destination with Work", "manuscript", body({ destinationWorkId: WORK_ID })],
  ])("rejects %s", (_label, sourceScheme, requestBody) => {
    expect(() => parseContextMove({ sourceScheme, body: requestBody })).toThrow();
  });

  it("represents explicit no-Work source and destination authority", () => {
    expect(
      parseContextMove({
        sourceScheme: "scratch",
        body: body({ destinationScheme: "uploads", sourceWorkId: null, destinationWorkId: null }),
      }),
    ).toMatchObject({ source: { scope: "none" }, destination: { scope: "none" } });
  });
});

describe("handleContextMoveRequest", () => {
  it.each([
    ["foreign", { projectUserId: "other-user" }],
    ["soft-deleted", { projectDeletedAt: new Date() }],
  ])("rejects a %s project", async (_label, options) => {
    await expect(request(depsFor(options))).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    ["missing", undefined],
    ["foreign", { projectId: "project-2", deletedAt: null }],
    ["deleted", { projectId: "project-1", deletedAt: new Date() }],
  ])("rejects a %s Work", async (_label, work) => {
    const deps = depsFor({ works: work ? { [WORK_ID]: work } : {} });
    await expect(request(deps, body({ sourceWorkId: WORK_ID }), "scratch")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(deps.contextPorts.forWork).not.toHaveBeenCalled();
  });

  it("authorizes both Work locators together and commits the explicit writer command", async () => {
    const deps = depsFor({
      works: {
        [WORK_ID]: { projectId: "project-1" },
        [OTHER_WORK_ID]: { projectId: "project-1" },
      },
    });
    deps.port.commitWriterLocation.mockResolvedValue({
      ok: true,
      value: { movedNodeId: "node-1", destinationPath: "Drafts/Source.md" },
    });

    await expect(
      request(
        deps,
        body({
          sourceWorkId: WORK_ID,
          destinationScheme: "scratch",
          destinationFolderPath: "Drafts",
          destinationWorkId: OTHER_WORK_ID,
        }),
        "scratch",
      ),
    ).resolves.toEqual({
      status: "moved",
      scheme: "scratch",
      path: "Drafts/Source.md",
      name: "Source.md",
    });
    expect(deps.workRepo.listByProject).toHaveBeenCalledOnce();
    expect(deps.contextPorts.forWork).toHaveBeenCalledWith(
      expect.objectContaining({ workId: WORK_ID, workSlug: "work-1" }),
      "project-1",
      "user-1",
      new Map([
        ["work-1", expect.objectContaining({ workId: WORK_ID })],
        ["work-2", expect.objectContaining({ workId: OTHER_WORK_ID })],
      ]),
    );
    expect(deps.port.commitWriterLocation).toHaveBeenCalledWith(
      "scratch://@work-1/Source.md",
      "scratch://@work-2/Drafts/Source.md",
      { origin: { type: "human", userId: "user-1" } },
    );
  });

  it("commits no-Work to no-Work using explicit @/ authority", async () => {
    const deps = depsFor();
    await expect(
      request(
        deps,
        body({ destinationScheme: "scratch", destinationFolderPath: "Dest" }),
        "scratch",
      ),
    ).resolves.toMatchObject({ status: "moved" });
    expect(deps.port.commitWriterLocation).toHaveBeenCalledWith(
      "scratch://@/Source.md",
      "scratch://@/Dest/Source.md",
      { origin: { type: "human", userId: "user-1" } },
    );
  });

  it("commits no-Work to a real Work without exposing its ID", async () => {
    const deps = depsFor({ works: { [WORK_ID]: { projectId: "project-1" } } });
    await request(
      deps,
      body({
        destinationScheme: "scratch",
        destinationFolderPath: "Dest",
        destinationWorkId: WORK_ID,
      }),
      "scratch",
    );
    expect(deps.port.commitWriterLocation).toHaveBeenCalledWith(
      "scratch://@/Source.md",
      "scratch://@work-1/Dest/Source.md",
      expect.anything(),
    );
  });

  it.each([
    ["stale_source", "stale-source"],
    ["stale_target", "stale-target"],
  ] as const)("returns %s as a retry without a collision locator", async (code, reason) => {
    const deps = depsFor();
    deps.port.commitWriterLocation.mockResolvedValue({
      ok: false,
      error: { code, uri: "manuscript://Dest/Source.md" },
    });
    await expect(request(deps)).resolves.toEqual({ status: "retry", reason });
  });

  it("shapes a collision with its canonical locator", async () => {
    const deps = depsFor();
    deps.port.commitWriterLocation.mockResolvedValue({
      ok: false,
      error: { code: "conflict", uri: "manuscript://Dest/Source.md" },
    });
    await expect(request(deps)).resolves.toEqual({
      status: "conflict",
      collision: {
        scheme: "manuscript",
        path: "Dest/Source.md",
        authority: { kind: "project" },
      },
    });
  });

  it("shapes an explicit no-Work collision without contextual fallback", async () => {
    const deps = depsFor();
    deps.port.commitWriterLocation.mockResolvedValue({
      ok: false,
      error: { code: "conflict", uri: "scratch://@/Dest/Source.md" },
    });
    await expect(
      request(
        deps,
        body({ destinationScheme: "scratch", destinationFolderPath: "Dest" }),
        "scratch",
      ),
    ).resolves.toEqual({
      status: "conflict",
      collision: {
        scheme: "scratch",
        path: "Dest/Source.md",
        authority: { kind: "none" },
      },
    });
  });

  it("maps a qualified collision back to its internal Work identity", async () => {
    const deps = depsFor({ works: { [WORK_ID]: { projectId: "project-1" } } });
    deps.port.commitWriterLocation.mockResolvedValue({
      ok: false,
      error: { code: "conflict", uri: "scratch://@work-1/Dest/Source.md" },
    });
    await expect(
      request(
        deps,
        body({
          sourceWorkId: WORK_ID,
          destinationScheme: "scratch",
          destinationWorkId: WORK_ID,
        }),
        "scratch",
      ),
    ).resolves.toEqual({
      status: "conflict",
      collision: {
        scheme: "scratch",
        path: "Dest/Source.md",
        authority: { kind: "work", workId: WORK_ID, workSlug: testWorkSlug("work-1") },
      },
    });
  });

  it("refuses a conflict locator whose authority is no longer known", async () => {
    const deps = depsFor();
    deps.port.commitWriterLocation.mockResolvedValue({
      ok: false,
      error: { code: "conflict", uri: "scratch://@missing-work/Dest/Source.md" },
    });
    await expect(request(deps)).rejects.toMatchObject({ statusCode: 500 });
  });
});
