/** Contract coverage for the deliberately single-Work default resolver. */
import type { Project } from "@meridian/contracts/projects";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { resolveDefaultWork } from "./default-work.js";

const USER_ID = "user-1";
const PROJECT_ID = "project-1";
const WORK_ID = "work-1";
const project = { id: PROJECT_ID, userId: USER_ID } as Project;
const work = { id: WORK_ID, projectId: PROJECT_ID } as Work;

describe("resolveDefaultWork", () => {
  it("returns the project's only active Work", async () => {
    const ensureDefaultForProject = vi.fn();

    await expect(
      resolveDefaultWork(
        {
          works: {
            listByProject: async () => [work],
            ensureDefaultForProject,
          } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(WORK_ID);
    expect(ensureDefaultForProject).not.toHaveBeenCalled();
  });

  it("provisions the invariant when a project has no active Work", async () => {
    const ensureDefaultForProject = vi.fn(async () => work);
    await expect(
      resolveDefaultWork(
        {
          works: {
            listByProject: async () => [],
            ensureDefaultForProject,
          } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(WORK_ID);
    expect(ensureDefaultForProject).toHaveBeenCalledWith(PROJECT_ID, project.title);
  });

  it("refuses to invent selection policy when multiple Works exist", async () => {
    await expect(
      resolveDefaultWork(
        {
          works: {
            listByProject: async () => [work, { ...work, id: "work-2" }],
          } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).rejects.toThrow("expected one");
  });
});
