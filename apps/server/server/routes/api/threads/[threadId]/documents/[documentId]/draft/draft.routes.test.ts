import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireAppUser: vi.fn() }));

vi.mock("../../../../../../../lib/auth-gate.js", () => ({
  requireAppUser: auth.requireAppUser,
}));
vi.mock("../../../../../../../../lib/auth-gate.js", () => ({
  requireAppUser: auth.requireAppUser,
}));

vi.mock("nitro/h3", () => ({
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (event: { params?: Record<string, string> }, name: string) =>
    event.params?.[name],
  readBody: (event: { body?: unknown }) => event.body ?? {},
  createError: (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), input),
}));

type TestEvent = { params?: Record<string, string>; body?: unknown };

const threadId = "thread-1";
const documentId = "doc-1";
const userId = "user-1";
const projectId = "project-1";

function makeApp(
  options: {
    threadUserId?: string;
    hasDocumentAccess?: boolean;
    isProjectDocument?: boolean;
    isThreadDocument?: boolean;
    activeDraft?: unknown;
    acceptResult?: unknown;
    rejectResult?: unknown;
  } = {},
) {
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
      canAccessDocument: vi.fn(async () => options.hasDocumentAccess ?? true),
      canAccessProjectDocument: vi.fn(async () => options.isProjectDocument ?? true),
    },
    uploadDocuments: {
      getUpload: vi.fn(async () =>
        options.isThreadDocument === false ? null : { threadId, documentId },
      ),
    },
    documentSync: {
      readAsMarkdown: vi.fn(async () => ({ ok: true, value: "Live" })),
      drafts: {
        getActiveDraft: vi.fn(async () => options.activeDraft ?? null),
        previewMarkdown: vi.fn(async () => "Preview"),
        acceptDraft: vi.fn(async () => options.acceptResult ?? { status: "not_found" }),
        rejectDraft: vi.fn(async () => options.rejectResult ?? { status: "not_found" }),
      },
    },
  };
}

describe("thread document draft routes", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.requireAppUser.mockReset();
  });

  it("returns live markdown and no preview when there is no active draft", async () => {
    const app = makeApp();
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./index.get.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(route({ params: { threadId, documentId } })).resolves.toEqual({
      draft: null,
      live: "Live",
    });
  });

  it("returns live and preview markdown for an active draft", async () => {
    const app = makeApp({
      activeDraft: {
        id: "draft-1",
        status: "active",
        lastActorTurnId: "turn-1",
        updatedAt: new Date("2026-06-27T12:00:00.000Z"),
      },
    });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./index.get.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    const response = await route({ params: { threadId, documentId } });

    expect(response).toEqual({
      draft: {
        id: "draft-1",
        status: "active",
        lastActorTurnId: "turn-1",
        updatedAt: "2026-06-27T12:00:00.000Z",
      },
      live: "Live",
      preview: "Preview",
    });
    expect(app.documentSync.drafts.previewMarkdown).toHaveBeenCalledWith({
      documentId,
      draftId: "draft-1",
    });
  });

  it("accepts a draft and returns the applied journal sequence", async () => {
    const app = makeApp({
      acceptResult: {
        status: "applied",
        draftId: "draft-1",
        appliedUpdateSeq: 42,
        acceptTurnId: "turn-accept",
      },
    });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./accept/index.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(route({ params: { threadId, documentId } })).resolves.toEqual({
      status: "applied",
      draftId: "draft-1",
      appliedUpdateSeq: 42,
      acceptTurnId: "turn-accept",
    });
    expect(app.documentSync.drafts.acceptDraft).toHaveBeenCalledWith({
      threadId,
      documentId,
      userId,
      confirmOverlap: false,
    });
  });

  it("passes overlap confirmation through to accept", async () => {
    const app = makeApp({
      acceptResult: {
        status: "applied",
        draftId: "draft-1",
        appliedUpdateSeq: 42,
        acceptTurnId: "turn-accept",
      },
    });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./accept/index.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await route({ params: { threadId, documentId }, body: { confirmOverlap: true } });

    expect(app.documentSync.drafts.acceptDraft).toHaveBeenCalledWith({
      threadId,
      documentId,
      userId,
      confirmOverlap: true,
    });
  });

  it("rejects a draft", async () => {
    const app = makeApp({ rejectResult: { status: "discarded", draftId: "draft-1" } });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./reject/index.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(route({ params: { threadId, documentId } })).resolves.toEqual({
      status: "discarded",
      draftId: "draft-1",
    });
  });

  it("returns 404 for a thread owned by another user", async () => {
    const app = makeApp({ threadUserId: "user-2" });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./index.get.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(route({ params: { threadId, documentId } })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it.each([
    ["wrong user document", { hasDocumentAccess: false }],
    ["document outside thread project", { isProjectDocument: false }],
    ["document not attached to thread", { isThreadDocument: false }],
  ])("returns 404 for %s", async (_label, options) => {
    const app = makeApp(options);
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./index.get.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(route({ params: { threadId, documentId } })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
