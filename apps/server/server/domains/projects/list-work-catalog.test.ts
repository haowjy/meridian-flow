/** Work catalog projection contracts across projects and collab. */
import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { listWorkCatalog } from "./list-work-catalog.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000101" as ProjectId;
const USER_ID = "00000000-0000-4000-8000-000000000102" as UserId;
const WORK_A = "00000000-0000-4000-8000-000000000103" as WorkId;
const WORK_B = "00000000-0000-4000-8000-000000000104" as WorkId;

describe("Work catalog", () => {
  it("projects all pending counts with one set-oriented collab read", async () => {
    const works = [work(WORK_A), work(WORK_B)];
    const countPendingByWorkIds = vi.fn(async () => new Map([[WORK_B, 3]]));

    const result = await listWorkCatalog(
      {
        projects: { findById: vi.fn(async () => project()) } as never,
        works: { listByProject: vi.fn(async () => works) },
        pendingDrafts: { countPendingByWorkIds },
      },
      { projectId: PROJECT_ID, userId: USER_ID, status: "active" },
    );

    expect(countPendingByWorkIds).toHaveBeenCalledTimes(1);
    expect(countPendingByWorkIds).toHaveBeenCalledWith([WORK_A, WORK_B]);
    expect(result.map(({ id, unpushedChangeCount }) => [id, unpushedChangeCount])).toEqual([
      [WORK_A, 0],
      [WORK_B, 3],
    ]);
  });

  it("keeps an empty catalog to one cheap empty-set delegation", async () => {
    const countPendingByWorkIds = vi.fn(async () => new Map());

    await expect(
      listWorkCatalog(
        {
          projects: { findById: vi.fn(async () => project()) } as never,
          works: { listByProject: vi.fn(async () => []) },
          pendingDrafts: { countPendingByWorkIds },
        },
        { projectId: PROJECT_ID, userId: USER_ID },
      ),
    ).resolves.toEqual([]);
    expect(countPendingByWorkIds).toHaveBeenCalledOnce();
    expect(countPendingByWorkIds).toHaveBeenCalledWith([]);
  });
});

function project(): Project {
  return { id: PROJECT_ID, userId: USER_ID, deletedAt: null } as Project;
}

function work(id: WorkId): Work {
  return { id, projectId: PROJECT_ID, status: "active", deletedAt: null } as Work;
}
