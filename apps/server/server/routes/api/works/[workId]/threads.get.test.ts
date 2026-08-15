/** Work-associated chat HTTP boundary: owner concealment and association delegation. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import handler from "./threads.get.js";

vi.mock("../../../../lib/auth-gate.js", () => ({ requireAppUser: vi.fn() }));

const USER_ID = "00000000-0000-4000-8000-000000000801";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000802";
const PROJECT_ID = "00000000-0000-4000-8000-000000000803";
const WORK_ID = "00000000-0000-4000-8000-000000000804";

function event(workId = WORK_ID) {
  return {
    req: new Request(`https://server.local/api/works/${workId}/threads`),
    context: { params: { workId } },
    res: { status: 200 },
  };
}

function fixture(projectUserId = USER_ID) {
  const listByWork = vi.fn(async () => [{ id: "thread-1", work: { id: "current-work" } }]);
  return {
    listByWork,
    app: {
      workRepo: {
        findById: vi.fn(async () => ({ id: WORK_ID, projectId: PROJECT_ID, deletedAt: null })),
      },
      projectRepo: {
        findById: vi.fn(async () => ({
          id: PROJECT_ID,
          userId: projectUserId,
          deletedAt: null,
        })),
      },
      repos: { threads: { listByWork } },
    },
  };
}

describe("GET /api/works/:workId/threads", () => {
  beforeEach(() => vi.mocked(requireAppUser).mockReset());

  it("returns associated rows and delegates with the owned Work's project", async () => {
    const f = fixture();
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);

    await expect(handler(event() as never)).resolves.toMatchObject({
      value: { threads: [{ id: "thread-1", work: { id: "current-work" } }] },
    });
    expect(f.listByWork).toHaveBeenCalledWith(PROJECT_ID, WORK_ID);
  });

  it("conceals a Work in another writer's project before reading associations", async () => {
    const f = fixture(OTHER_USER_ID);
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);

    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 404 });
    expect(f.listByWork).not.toHaveBeenCalled();
  });
});
