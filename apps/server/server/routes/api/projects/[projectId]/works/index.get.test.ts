/** GET Work collection regression: multi-Work projects are ordinary 200 responses (#452). */
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

function work(id: string): Work {
  return {
    id,
    projectId: PROJECT_ID,
    status: "active",
    deletedAt: null,
  } as Work;
}

describe("GET /api/projects/:projectId/works", () => {
  beforeEach(() => {
    vi.mocked(requireAppUser).mockReset();
  });

  it("returns 200 and both Works when two active Works exist", async () => {
    const works = [work("work-2"), work("work-1")];
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: {
        projectRepo: { findById: async () => project },
        workRepo: {
          findById: async () => null,
          listByProject: async () => works,
        },
        preferences: { getCurrentWorkId: async () => null },
        documentSync: { countUnpushedRowsForWork: async () => 0 },
      },
    } as never);
    const event = {
      req: new Request(`https://server.local/api/projects/${PROJECT_ID}/works`),
      context: { params: { projectId: PROJECT_ID } },
      res: { status: 200 },
    };

    const response = await handler(event as never);

    expect(event.res.status).toBe(200);
    expect(response).toMatchObject({
      value: {
        defaultWorkId: "work-2",
        works: [{ id: "work-2" }, { id: "work-1" }],
      },
    });
  });
});
