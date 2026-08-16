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

function event(status?: "active" | "archived" | "all") {
  const query = status ? `?status=${status}` : "";
  return {
    req: new Request(`https://server.local/api/projects/${PROJECT_ID}/works${query}`),
    context: { params: { projectId: PROJECT_ID } },
    res: { status: 200 },
  };
}

describe("GET /api/projects/:projectId/works", () => {
  beforeEach(() => {
    vi.mocked(requireAppUser).mockReset();
  });

  it.each([
    [undefined, { status: "active" }],
    ["active", { status: "active" }],
    ["archived", { status: "archived" }],
    ["all", undefined],
  ] as const)("lists exactly the requested %s Work collection", async (status, expectedFilter) => {
    const works =
      status === "archived"
        ? [work("archived", "archived")]
        : status === "all"
          ? [work("active"), work("archived", "archived")]
          : [work("work-2"), work("work-1")];
    const listByProject = vi.fn(async () => works);
    const preferences = {
      getNewChatFallbackWorkId: vi.fn(async () => {
        throw new Error("collection GET must not read fallback preference");
      }),
      repairNewChatFallbackWorkId: vi.fn(async () => {
        throw new Error("collection GET must not repair fallback preference");
      }),
    };
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: {
        projectRepo: { findById: async () => project },
        workRepo: { listByProject },
        preferences,
        documentSync: { countUnpushedRowsForWork: async () => 0 },
      },
    } as never);

    const response = await handler(event(status) as never);

    expect(response).toMatchObject({
      value: {
        works: works.map((work) => ({ ...work, unpushedChangeCount: 0 })),
      },
    });
    expect(Object.keys(response.value)).toEqual(["works"]);
    expect(listByProject).toHaveBeenCalledWith(PROJECT_ID, expectedFilter);
    expect(preferences.getNewChatFallbackWorkId).not.toHaveBeenCalled();
    expect(preferences.repairNewChatFallbackWorkId).not.toHaveBeenCalled();
  });
});
