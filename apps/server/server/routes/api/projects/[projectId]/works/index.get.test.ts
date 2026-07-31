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

function work(id: string, status: Work["status"] = "active"): Work {
  return {
    id,
    projectId: PROJECT_ID,
    status,
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
        preferences: {
          getCurrentWorkId: async () => null,
          setCurrentWorkId: async () => {},
        },
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

  it("includes the archived current Work in the default active list", async () => {
    const active = work("active");
    const current = { ...work("current"), status: "archived" as const };
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: {
        projectRepo: { findById: async () => project },
        workRepo: {
          findById: async () => current,
          listByProject: async () => [active],
        },
        preferences: { getCurrentWorkId: async () => current.id },
        documentSync: { countUnpushedRowsForWork: async () => 0 },
      },
    } as never);
    const event = {
      req: new Request(`https://server.local/api/projects/${PROJECT_ID}/works`),
      context: { params: { projectId: PROJECT_ID } },
      res: { status: 200 },
    };

    const response = await handler(event as never);

    expect(response).toMatchObject({
      value: {
        defaultWorkId: current.id,
        works: [
          { id: current.id, status: "archived" },
          { id: active.id, status: "active" },
        ],
      },
    });
  });

  it("returns active and archived Works for status=all", async () => {
    const works = [work("active"), work("archived", "archived")];
    const listByProject = vi.fn(async () => works);
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: {
        projectRepo: { findById: async () => project },
        workRepo: {
          findById: async () => works[0],
          listByProject,
        },
        preferences: { getCurrentWorkId: async () => works[0]?.id },
        documentSync: { countUnpushedRowsForWork: async () => 0 },
      },
    } as never);
    const event = {
      req: new Request(`https://server.local/api/projects/${PROJECT_ID}/works?status=all`),
      context: { params: { projectId: PROJECT_ID } },
      res: { status: 200 },
    };

    const response = await handler(event as never);

    expect(listByProject).toHaveBeenCalledWith(PROJECT_ID, undefined);
    expect(response).toMatchObject({
      value: {
        works: [{ id: "active" }, { id: "archived" }],
      },
    });
  });
});
