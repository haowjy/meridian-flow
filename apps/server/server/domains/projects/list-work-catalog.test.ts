/** Work catalog projection contracts across projects and collab. */
import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { decodeWorkSlug } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { listWorkCatalog } from "./list-work-catalog.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000101" as ProjectId;
const USER_ID = "00000000-0000-4000-8000-000000000102" as UserId;
const WORK_A = "00000000-0000-4000-8000-000000000103" as WorkId;
const WORK_B = "00000000-0000-4000-8000-000000000104" as WorkId;
const NO_WORK_ID = "00000000-0000-4000-8000-000000000105" as WorkId;

describe("Work catalog", () => {
  it("projects named Works and No Work with one set-oriented collab read", async () => {
    const works = [work(WORK_A, "alpha"), work(WORK_B, "beta")];
    const noWork = lockedWork();
    const countPendingByWorkIds = vi.fn(async () => new Map([[WORK_B, 3]]));

    const result = await listWorkCatalog(
      {
        projects: { findById: vi.fn(async () => project()) } as never,
        works: snapshotRepo(works, noWork),
        pendingDrafts: { countPendingByWorkIds },
      },
      { projectId: PROJECT_ID, userId: USER_ID },
    );

    expect(countPendingByWorkIds).toHaveBeenCalledTimes(1);
    expect(countPendingByWorkIds).toHaveBeenCalledWith([WORK_A, WORK_B, NO_WORK_ID]);
    expect(result.works.map(({ id, unpushedChangeCount }) => [id, unpushedChangeCount])).toEqual([
      [WORK_A, 0],
      [WORK_B, 3],
    ]);
    expect(result.noWork).toMatchObject({
      id: NO_WORK_ID,
      isNoWork: true,
      slug: null,
      unpushedChangeCount: 0,
    });
    expect(result.works.every((entry) => entry.isNoWork === false)).toBe(true);
  });

  it("fails loudly when No Work is missing", async () => {
    await expect(
      listWorkCatalog(
        {
          projects: { findById: vi.fn(async () => project()) } as never,
          works: snapshotRepo([], null),
          pendingDrafts: { countPendingByWorkIds: vi.fn(async () => new Map()) },
        },
        { projectId: PROJECT_ID, userId: USER_ID },
      ),
    ).rejects.toThrow(/missing No Work/);
  });
});

function project(): Project {
  return { id: PROJECT_ID, userId: USER_ID, deletedAt: null } as Project;
}

function work(id: WorkId, slug: string): Work {
  const decoded = decodeWorkSlug(slug);
  if (!decoded) throw new Error("invalid fixture slug");
  return {
    id,
    projectId: PROJECT_ID,
    status: "active",
    deletedAt: null,
    slug: decoded,
    isNoWork: false,
  } as Work;
}

function lockedWork(): Work {
  return {
    id: NO_WORK_ID,
    projectId: PROJECT_ID,
    name: "No Work",
    slug: null,
    isNoWork: true,
    status: "active",
    deletedAt: null,
  } as Work;
}

function snapshotRepo(rows: Work[], noWork: Work | null) {
  return {
    readSnapshot: async <T>(operation: () => Promise<T>) => operation(),
    snapshotIdentity: async () => ({
      catalogGeneration: "00000000-0000-4000-8000-000000000109",
      authorityRevision: "0",
    }),
    listByProject: vi.fn(async () => rows),
    findNoWork: vi.fn(async () => noWork),
  };
}
