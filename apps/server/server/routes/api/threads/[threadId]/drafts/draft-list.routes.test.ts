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

function makeApp(
  options: {
    threadUserId?: string;
    drafts?: Array<{ documentId: string } & Record<string, unknown>>;
    accessibleDocumentIds?: Set<string>;
    projectDocumentIds?: Set<string>;
    attachedDocumentIds?: Set<string>;
  } = {},
) {
  const accessibleDocumentIds = options.accessibleDocumentIds;
  const projectDocumentIds = options.projectDocumentIds;
  const attachedDocumentIds = options.attachedDocumentIds;
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
      canAccessDocument: vi.fn(
        async (_userId: string, documentId: string) =>
          accessibleDocumentIds?.has(documentId) ?? true,
      ),
      canAccessProjectDocument: vi.fn(
        async (_userId: string, documentId: string, _projectId: string) =>
          projectDocumentIds?.has(documentId) ?? true,
      ),
    },
    uploadDocuments: {
      getUpload: vi.fn(async (_threadId: string, documentId: string) =>
        (attachedDocumentIds?.has(documentId) ?? true)
          ? { threadId, documentId, name: `Document ${documentId}` }
          : null,
      ),
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
          documentName: "Chapter One",
          status: "active",
          lastActorTurnId: "turn-1",
          updatedAt: new Date("2026-06-27T12:00:00.000Z"),
        },
        {
          id: "draft-2",
          documentId: "doc-2",
          documentName: null,
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
          documentName: "Chapter One",
          status: "active",
          lastActorTurnId: "turn-1",
          updatedAt: "2026-06-27T12:00:00.000Z",
        },
        {
          draftId: "draft-2",
          documentId: "doc-2",
          documentName: null,
          status: "active",
          lastActorTurnId: null,
          updatedAt: "2026-06-27T13:00:00.000Z",
        },
      ],
    });
    expect(app.documentSync.drafts.listActiveDrafts).toHaveBeenCalledWith({ threadId });
    expect(app.documentAccess.canAccessDocument).toHaveBeenCalledTimes(2);
    expect(app.documentAccess.canAccessProjectDocument).toHaveBeenCalledTimes(2);
  });

  it("excludes inaccessible draft documents but keeps unattached ones", async () => {
    // Drafts are thread-scoped in the DB; the filter only checks document
    // ownership + project membership. Thread-document attachment is NOT
    // required — project documents reachable via the context port may have
    // no thread_documents row, but the AI can still draft against them.
    const app = makeApp({
      accessibleDocumentIds: new Set(["doc-visible", "doc-unattached"]),
      projectDocumentIds: new Set(["doc-visible", "doc-unattached"]),
      attachedDocumentIds: new Set(["doc-visible", "doc-inaccessible"]),
      drafts: [
        {
          id: "draft-visible",
          documentId: "doc-visible",
          documentName: "Visible chapter",
          status: "active",
          lastActorTurnId: "turn-1",
          updatedAt: new Date("2026-06-27T12:00:00.000Z"),
        },
        {
          id: "draft-inaccessible",
          documentId: "doc-inaccessible",
          documentName: "Hidden chapter",
          status: "active",
          lastActorTurnId: "turn-2",
          updatedAt: new Date("2026-06-27T13:00:00.000Z"),
        },
        {
          id: "draft-unattached",
          documentId: "doc-unattached",
          documentName: "Detached chapter",
          status: "active",
          lastActorTurnId: "turn-3",
          updatedAt: new Date("2026-06-27T14:00:00.000Z"),
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
          draftId: "draft-visible",
          documentId: "doc-visible",
          documentName: "Visible chapter",
          status: "active",
          lastActorTurnId: "turn-1",
          updatedAt: "2026-06-27T12:00:00.000Z",
        },
        {
          draftId: "draft-unattached",
          documentId: "doc-unattached",
          documentName: "Detached chapter",
          status: "active",
          lastActorTurnId: "turn-3",
          updatedAt: "2026-06-27T14:00:00.000Z",
        },
      ],
    });
    expect(app.documentAccess.canAccessDocument).toHaveBeenCalledTimes(3);
    expect(app.documentAccess.canAccessProjectDocument).toHaveBeenCalledTimes(3);
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
