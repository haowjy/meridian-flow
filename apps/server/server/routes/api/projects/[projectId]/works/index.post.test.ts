/** POST Work collection coverage for current-Work selection on creation. */
import type { Project } from "@meridian/contracts/projects";
import type { Work } from "@meridian/contracts/works";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import handler from "./index.post.js";

vi.mock("../../../../../lib/auth-gate.js", () => ({
  requireAppUser: vi.fn(),
}));

const PROJECT_ID = "00000000-0000-4000-8000-000000000821";
const USER_ID = "00000000-0000-4000-8000-000000000822";
const WORK_ID = "00000000-0000-4000-8000-000000000823";

describe("POST /api/projects/:projectId/works", () => {
  beforeEach(() => {
    vi.mocked(requireAppUser).mockReset();
  });

  it("makes the created Work current for its creator", async () => {
    const project = { id: PROJECT_ID, userId: USER_ID, deletedAt: null } as Project;
    const created = {
      id: WORK_ID,
      projectId: PROJECT_ID,
      name: "Act 2",
      status: "active",
      deletedAt: null,
    } as Work;
    const setCurrentWorkId = vi.fn();
    const projectChanged = vi.fn();
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: {
        projectRepo: { findById: async () => project },
        workRepo: {
          transaction: async (operation: () => Promise<unknown>) => operation(),
          create: async () => created,
        },
        preferences: { setCurrentWorkId },
        systemUpdates: { projectChanged },
      },
    } as never);
    const event = {
      req: new Request(`https://server.local/api/projects/${PROJECT_ID}/works`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Act 2" }),
      }),
      context: { params: { projectId: PROJECT_ID } },
      res: { status: 200 },
    };

    await expect(handler(event as never)).resolves.toMatchObject({
      value: { id: WORK_ID, name: "Act 2" },
    });
    expect(setCurrentWorkId).toHaveBeenCalledWith(USER_ID, PROJECT_ID, WORK_ID);
    expect(projectChanged).toHaveBeenCalledWith(PROJECT_ID);
    expect(event.res.status).toBe(201);
  });
});
