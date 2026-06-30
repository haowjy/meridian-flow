import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireAppUser: vi.fn() }));

vi.mock("../../../../lib/auth-gate.js", () => ({
  requireAppUser: auth.requireAppUser,
}));

vi.mock("nitro/h3", () => ({
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (event: { params?: Record<string, string> }, name: string) =>
    event.params?.[name],
  readBody: (event: { body?: unknown }) => event.body,
  createError: (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), input),
}));

type TestEvent = { params?: Record<string, string>; body?: unknown };

const threadId = "thread-1";
const userId = "user-1";

function makeApp(options: { threadUserId?: string; draftCount?: number } = {}) {
  return {
    threadRepos: {
      threads: {
        findById: vi.fn(async () => ({
          id: threadId,
          userId: options.threadUserId ?? userId,
          projectId: "project-1",
        })),
        updateWriteMode: vi.fn(async () => undefined),
      },
    },
    documentSync: {
      drafts: {
        listActiveDrafts: vi.fn(async () =>
          Array.from({ length: options.draftCount ?? 0 }, (_, index) => ({ id: `draft-${index}` })),
        ),
      },
    },
  };
}

async function loadRoute() {
  return (await import("./write-mode.patch.js")).default as unknown as (
    event: TestEvent,
  ) => Promise<unknown>;
}

describe("thread write mode route", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.requireAppUser.mockReset();
  });

  it("allows switching to draft mode without checking active drafts", async () => {
    const app = makeApp({ draftCount: 1 });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = await loadRoute();

    await expect(route({ params: { threadId }, body: { aiWriteMode: "draft" } })).resolves.toEqual({
      aiWriteMode: "draft",
    });

    expect(app.documentSync.drafts.listActiveDrafts).not.toHaveBeenCalled();
    expect(app.threadRepos.threads.updateWriteMode).toHaveBeenCalledWith(threadId, "draft");
  });

  it("blocks switching to direct mode while active drafts exist", async () => {
    const app = makeApp({ draftCount: 1 });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = await loadRoute();

    await expect(
      route({ params: { threadId }, body: { aiWriteMode: "direct" } }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(app.documentSync.drafts.listActiveDrafts).toHaveBeenCalledWith({ threadId });
    expect(app.threadRepos.threads.updateWriteMode).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's thread", async () => {
    const app = makeApp({ threadUserId: "user-2" });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = await loadRoute();

    await expect(
      route({ params: { threadId }, body: { aiWriteMode: "draft" } }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(app.threadRepos.threads.updateWriteMode).not.toHaveBeenCalled();
  });
});
