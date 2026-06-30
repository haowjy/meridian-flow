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
  getQuery: (event: { query?: Record<string, string> }) => event.query ?? {},
  readBody: (event: { body?: unknown }) => event.body ?? {},
  createError: (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), input),
}));

type TestEvent = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
};

const threadId = "thread-1";
const documentId = "doc-1";
const userId = "user-1";
const projectId = "project-1";

function makeApp(
  options: {
    threadUserId?: string;
    hasDocumentAccess?: boolean;
    isProjectDocument?: boolean;
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
    documentSync: {
      readAsMarkdown: vi.fn(async () => ({ ok: true, value: "Live" })),
      drafts: {
        getActiveDraft: vi.fn(async () => options.activeDraft ?? null),
        previewDraft: vi.fn(async () => ({
          live: "Live",
          markdown: "Preview",
          liveRevisionToken: 7,
        })),
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
      status: "gone",
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

    const response = await route({
      params: { threadId, documentId },
      query: { draftId: "draft-1" },
    });

    expect(response).toEqual({
      status: "active",
      draftId: "draft-1",
      live: "Live",
      preview: "Preview",
      liveRevisionToken: 7,
    });
    expect(app.documentSync.drafts.previewDraft).toHaveBeenCalledWith({
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

    await expect(
      route({ params: { threadId, documentId }, body: { draftId: "draft-1" } }),
    ).resolves.toEqual({
      status: "applied",
      draftId: "draft-1",
      appliedUpdateSeq: 42,
      acceptTurnId: "turn-accept",
    });
    expect(app.documentSync.drafts.acceptDraft).toHaveBeenCalledWith({
      threadId,
      documentId,
      draftId: "draft-1",
      userId,
      confirmOverlap: false,
      confirmedLiveRevisionToken: undefined,
    });
  });

  it.each([
    ["missing", { status: "not_found" }, 404],
    ["already discarded", { status: "discarded", draftId: "draft-1" }, 410],
    ["accept in progress", { status: "in_progress", draftId: "draft-1" }, 409],
  ])("returns HTTP error for %s accept result", async (_label, acceptResult, statusCode) => {
    const app = makeApp({ acceptResult });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./accept/index.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(
      route({ params: { threadId, documentId }, body: { draftId: "draft-1" } }),
    ).rejects.toMatchObject({ statusCode });
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

    await route({
      params: { threadId, documentId },
      body: { draftId: "draft-1", confirmOverlap: true, confirmedLiveRevisionToken: 7 },
    });

    expect(app.documentSync.drafts.acceptDraft).toHaveBeenCalledWith({
      threadId,
      documentId,
      draftId: "draft-1",
      userId,
      confirmOverlap: true,
      confirmedLiveRevisionToken: 7,
    });
  });

  it("rejects a draft", async () => {
    const app = makeApp({ rejectResult: { status: "discarded", draftId: "draft-1" } });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./reject/index.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(
      route({ params: { threadId, documentId }, body: { draftId: "draft-1" } }),
    ).resolves.toEqual({
      status: "discarded",
      draftId: "draft-1",
    });
  });

  it("returns 404 when rejecting a missing draft", async () => {
    const app = makeApp({ rejectResult: { status: "not_found" } });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./reject/index.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(
      route({ params: { threadId, documentId }, body: { draftId: "draft-1" } }),
    ).rejects.toMatchObject({ statusCode: 404 });
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
