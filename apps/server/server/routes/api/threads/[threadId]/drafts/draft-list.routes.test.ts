import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireAppUser: vi.fn() }));

vi.mock("../../../../../lib/auth-gate.js", () => ({
  requireAppUser: auth.requireAppUser,
}));

vi.mock("nitro/h3", () => ({
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (event: { params?: Record<string, string> }, name: string) =>
    event.params?.[name],
  createError: (input: { statusCode: number; message: string; data?: unknown }) =>
    Object.assign(new Error(input.message), input),
}));

type TestEvent = { params?: Record<string, string> };

const threadId = "thread-1";
const userId = "user-1";
const projectId = "project-1";

function makeApp(options: { threadUserId?: string; drafts?: unknown[] } = {}) {
  return {
    threadRepos: {
      threads: {
        findById: vi.fn(async () => ({
          id: threadId,
          userId: options.threadUserId ?? userId,
          projectId,
          deletedAt: null,
        })),
      },
    },
    projectRepo: {
      findById: vi.fn(async () => ({ id: projectId, userId, deletedAt: null })),
    },
    documentAccess: {
      canAccessDocument: vi.fn(),
      canAccessProjectDocument: vi.fn(),
    },
    uploadDocuments: {
      getUpload: vi.fn(),
    },
    documentSync: {
      drafts: {
        listActiveDrafts: vi.fn(async () => options.drafts ?? []),
      },
    },
  };
}

describe("thread draft list route", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.requireAppUser.mockReset();
  });

  it("returns active drafts for a thread", async () => {
    const app = makeApp({
      drafts: [
        {
          id: "draft-1",
          documentId: "doc-1",
          status: "active",
          lastActorTurnId: "turn-1",
          updatedAt: new Date("2026-06-27T12:00:00.000Z"),
        },
        {
          id: "draft-2",
          documentId: "doc-2",
          status: "active",
          lastActorTurnId: null,
          updatedAt: new Date("2026-06-27T13:00:00.000Z"),
        },
      ],
    });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./index.get.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(route({ params: { threadId } })).resolves.toEqual({
      drafts: [
        {
          draftId: "draft-1",
          documentId: "doc-1",
          status: "active",
          lastActorTurnId: "turn-1",
          updatedAt: "2026-06-27T12:00:00.000Z",
        },
        {
          draftId: "draft-2",
          documentId: "doc-2",
          status: "active",
          lastActorTurnId: null,
          updatedAt: "2026-06-27T13:00:00.000Z",
        },
      ],
    });
    expect(app.documentSync.drafts.listActiveDrafts).toHaveBeenCalledWith({ threadId });
    expect(app.documentAccess.canAccessDocument).not.toHaveBeenCalled();
    expect(app.uploadDocuments.getUpload).not.toHaveBeenCalled();
  });

  it("returns 404 for a thread owned by another user", async () => {
    const app = makeApp({ threadUserId: "user-2" });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./index.get.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(route({ params: { threadId } })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(app.documentSync.drafts.listActiveDrafts).not.toHaveBeenCalled();
  });
});
