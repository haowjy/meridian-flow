/** Thread user-state HTTP boundary: auth, ownership, body validation, and response shape. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import handler from "./user-state.patch.js";

vi.mock("../../../../lib/auth-gate.js", () => ({ requireAppUser: vi.fn() }));

const THREAD_ID = "00000000-0000-4000-8000-000000000711";
const PROJECT_ID = "00000000-0000-4000-8000-000000000712";
const USER_ID = "00000000-0000-4000-8000-000000000713";

function event(body: unknown, threadId = THREAD_ID) {
  return {
    req: new Request(`https://server.local/api/threads/${threadId}/user-state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    context: { params: { threadId } },
    res: { status: 200 },
  };
}

function fixture(projectUserId = USER_ID) {
  const update = vi.fn(async () => ({
    threadId: THREAD_ID,
    isFavorite: true,
    manuallyUnread: true,
    lastOpenedAt: null,
    attention: "unread",
  }));
  const findById = vi.fn(async () => ({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    deletedAt: null,
  }));
  return {
    update,
    findById,
    app: {
      repos: { threads: { findById }, threadUserState: { update } },
      projectRepo: {
        findById: vi.fn(async () => ({ id: PROJECT_ID, userId: projectUserId, deletedAt: null })),
      },
    },
  };
}

describe("PATCH /api/threads/:threadId/user-state", () => {
  beforeEach(() => vi.mocked(requireAppUser).mockReset());

  it.each([
    {},
    { unread: true },
    { isUnread: "yes" },
  ])("rejects invalid body without repository access", async (body) => {
    const f = fixture();
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);
    await expect(handler(event(body) as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(f.findById).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it("rejects malformed thread IDs without repository access", async () => {
    const f = fixture();
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);
    await expect(handler(event({ isUnread: false }, "bad") as never)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(f.findById).not.toHaveBeenCalled();
  });

  it("conceals wrong ownership", async () => {
    const f = fixture("00000000-0000-4000-8000-000000000799");
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);
    await expect(handler(event({ isFavorite: true }) as never)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("passes combined desired state and returns the durable/effective shape", async () => {
    const f = fixture();
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);
    await expect(handler(event({ isFavorite: true, isUnread: true }) as never)).resolves.toEqual({
      __meridianTransport: true,
      value: {
        threadId: THREAD_ID,
        isFavorite: true,
        manuallyUnread: true,
        lastOpenedAt: null,
        attention: "unread",
      },
    });
    expect(f.update).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      userId: USER_ID,
      isFavorite: true,
      isUnread: true,
    });
    expect(vi.mocked(requireAppUser).mock.invocationCallOrder[0]).toBeLessThan(
      f.findById.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
