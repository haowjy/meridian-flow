/** GET Work collection regression: multi-Work projects are ordinary, side-effect-free reads (#452). */
import type { Project } from "@meridian/contracts/projects";
import type { Work } from "@meridian/contracts/works";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import handler from "./index.get.js";

vi.mock("../../../../../lib/auth-gate.js", () => ({
  requireAppUser: vi.fn(),
}));

const PROJECT_ID = "project-1";
const USER_ID = "user-1";
const project = {
  id: PROJECT_ID,
  userId: USER_ID,
  deletedAt: null,
} as Project;

function work(id: string, status: Work["status"] = "active"): Work {
  return {
    id,
    projectId: PROJECT_ID,
    status,
    deletedAt: null,
  } as Work;
}

function event() {
  return {
    req: new Request(`https://server.local/api/projects/${PROJECT_ID}/works`),
    context: { params: { projectId: PROJECT_ID } },
    res: { status: 200 },
  };
}

describe("GET /api/projects/:projectId/works", () => {
  beforeEach(() => {
    vi.mocked(requireAppUser).mockReset();
  });

  it("returns the one complete lifecycle snapshot", async () => {
    const works = [work("active"), work("archived", "archived")];
    const listByProject = vi.fn(async () => works);
    const countPendingByWorkIds = vi.fn(
      async (workIds: readonly string[]) => new Map(workIds.map((workId) => [workId, 0])),
    );
    const preferences = {};
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: {
        projectRepo: { findById: async () => project },
        workRepo: {
          readSnapshot: async (operation: () => Promise<unknown>) => operation(),
          snapshotIdentity: async () => ({
            catalogGeneration: "00000000-0000-4000-8000-000000000001",
            authorityRevision: "2",
          }),
          listByProject,
        },
        preferences,
        documentSync: { countPendingByWorkIds },
      },
    } as never);

    const response = await handler(event() as never);

    expect(response).toMatchObject({
      value: {
        works: works.map((work) => ({ ...work, unpushedChangeCount: 0 })),
      },
    });
    expect(Object.keys(response.value)).toEqual([
      "projectId",
      "catalogGeneration",
      "authorityRevision",
      "requestId",
      "works",
    ]);
    expect(listByProject).toHaveBeenCalledWith(PROJECT_ID, { includeDeleted: true });
    expect(countPendingByWorkIds).toHaveBeenCalledOnce();
    expect(countPendingByWorkIds).toHaveBeenCalledWith(works.map(({ id }) => id));
  });
});
