/** Current-Work resolution policy: preference, active recency, archive fallback, creation. */
import type { Project } from "@meridian/contracts/projects";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { resolveCurrentWork } from "./current-work.js";

const USER_ID = "user-1";
const PROJECT_ID = "project-1";
const project = { id: PROJECT_ID, userId: USER_ID, name: "My Book" } as Project;

function work(id: string, status: Work["status"] = "active"): Work {
  return { id, projectId: PROJECT_ID, status, deletedAt: null } as Work;
}

describe("resolveCurrentWork", () => {
  it("keeps an archived preference current", async () => {
    const preferred = work("preferred", "archived");
    const listByProject = vi.fn();

    await expect(
      resolveCurrentWork(
        {
          preferences: { getCurrentWorkId: async () => preferred.id } as never,
          works: { findById: async () => preferred, listByProject } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(preferred);
    expect(listByProject).not.toHaveBeenCalled();
  });

  it("falls back from a dangling preference to the most recently updated active Work", async () => {
    const active = work("active");
    const listByProject = vi.fn(async (_projectId, options) =>
      options?.status === "active" ? [active] : [],
    );

    await expect(
      resolveCurrentWork(
        {
          preferences: { getCurrentWorkId: async () => "deleted" } as never,
          works: { findById: async () => null, listByProject } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(active);
    expect(listByProject).toHaveBeenCalledWith(PROJECT_ID, { status: "active" });
  });

  it("uses the newest archived Work when no active Work remains", async () => {
    const archived = work("archived", "archived");
    const listByProject = vi.fn(async (_projectId, options) =>
      options?.status === "archived" ? [archived] : [],
    );

    await expect(
      resolveCurrentWork(
        {
          preferences: { getCurrentWorkId: async () => null } as never,
          works: { listByProject } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(archived);
  });

  it("creates a concretely named default only when the project has no Work", async () => {
    const created = work("created");
    const ensureDefaultForProject = vi.fn(async () => created);

    await expect(
      resolveCurrentWork(
        {
          preferences: { getCurrentWorkId: async () => null } as never,
          works: {
            listByProject: async () => [],
            ensureDefaultForProject,
          } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(created);
    expect(ensureDefaultForProject).toHaveBeenCalledWith(PROJECT_ID, "My Book");
  });
});
