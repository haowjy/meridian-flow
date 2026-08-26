/** Home feed HTTP boundary: auth, ownership, validation, and fixed page policy. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectChatCursor } from "../../../../domains/threads/domain/project-chat-cursor.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import handler from "./home-feed.get.js";

vi.mock("../../../../lib/auth-gate.js", () => ({ requireAppUser: vi.fn() }));

const PROJECT_ID = "00000000-0000-4000-8000-000000000701";
const USER_ID = "00000000-0000-4000-8000-000000000702";
const THREAD_ID = "00000000-0000-4000-8000-000000000703";

function event(query = "") {
  return {
    req: new Request(`https://server.local/api/projects/${PROJECT_ID}/home-feed${query}`),
    context: { params: { projectId: PROJECT_ID } },
    res: { status: 200 },
  };
}

function app(overrides: Record<string, unknown> = {}) {
  const queryPage = vi.fn(async () => ({ continueChat: null, favorites: [], recent: [] }));
  return {
    queryPage,
    value: {
      projectRepo: {
        findById: vi.fn(async () => ({ id: PROJECT_ID, userId: USER_ID, deletedAt: null })),
      },
      repos: { homeFeed: { queryPage } },
      ...overrides,
    },
  };
}

describe("GET /api/projects/:projectId/home-feed", () => {
  beforeEach(() => vi.mocked(requireAppUser).mockReset());

  it.each([
    "!",
    "eyJ2IjoxfQ==",
    Buffer.from(
      '{"v":1,"a":"2026-99-99T99:99:99.999999Z","i":"00000000-0000-4000-8000-000000000703"}',
    ).toString("base64url"),
    encodeProjectChatCursor({
      sortAt: "0000-01-01T00:00:00.000000Z",
      threadId: THREAD_ID,
    }),
  ])("rejects malformed cursor %s without repository access", async (cursor) => {
    const fixture = app();
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: fixture.value,
    } as never);
    await expect(
      handler(event(`?cursor=${encodeURIComponent(cursor)}`) as never),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fixture.value.projectRepo.findById).toHaveBeenCalledOnce();
    expect(fixture.queryPage).not.toHaveBeenCalled();
  });

  it.each([
    { userId: "00000000-0000-4000-8000-000000000799", deletedAt: null },
    { userId: USER_ID, deletedAt: new Date() },
  ])("conceals wrong-owner and deleted projects", async (project) => {
    const fixture = app({
      projectRepo: { findById: vi.fn(async () => ({ id: PROJECT_ID, ...project })) },
    });
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: fixture.value,
    } as never);
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 404 });
    expect(fixture.queryPage).not.toHaveBeenCalled();
  });

  it("returns the transport shape and enforces the 24-item public page policy", async () => {
    const fixture = app();
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: fixture.value,
    } as never);
    await expect(handler(event() as never)).resolves.toEqual({
      __meridianTransport: true,
      value: {
        featured: { continueChat: null, favoriteChats: [] },
        recentChats: { items: [], nextCursor: null },
      },
    });
    expect(fixture.queryPage).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      userId: USER_ID,
      after: null,
      recentLimit: 25,
      includeFeatured: true,
    });
    expect(vi.mocked(requireAppUser).mock.invocationCallOrder[0]).toBeLessThan(
      fixture.value.projectRepo.findById.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("accepts a canonical cursor and omits featured rows on later pages", async () => {
    const fixture = app();
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: USER_ID },
      app: fixture.value,
    } as never);
    const cursor = encodeProjectChatCursor({
      sortAt: "2026-08-13T20:01:02.123456Z",
      threadId: THREAD_ID,
    });
    await handler(event(`?cursor=${cursor}`) as never);
    expect(fixture.queryPage).toHaveBeenCalledWith(
      expect.objectContaining({
        after: { sortAt: "2026-08-13T20:01:02.123456Z", threadId: THREAD_ID },
        includeFeatured: false,
      }),
    );
  });
});
