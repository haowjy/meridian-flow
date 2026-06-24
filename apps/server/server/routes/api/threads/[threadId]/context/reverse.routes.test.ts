import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireAppUser: vi.fn() }));

vi.mock("../../../../../lib/auth-gate.js", () => ({
  requireAppUser: auth.requireAppUser,
}));

vi.mock("nitro/h3", () => ({
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (event: { params?: Record<string, string> }, name: string) =>
    event.params?.[name],
  getQuery: (event: { query?: Record<string, unknown> }) => event.query ?? {},
  readBody: async (event: { body?: unknown }) => event.body,
  setResponseStatus: (event: { status?: number }, status: number) => {
    event.status = status;
  },
  createError: (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), input),
}));

type TestEvent = {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  status?: number;
};

const threadId = "thread-1";
const userId = "user-1";
const documentId = "doc-1";

function makeApp(
  options: { threadUserId?: string; reverseOutcome?: unknown; availability?: unknown } = {},
) {
  const refreshed: Array<{ documentId: string; threadId?: string }> = [];
  const reverse = vi.fn(
    async () =>
      options.reverseOutcome ?? {
        command: "undo",
        status: "reversed",
        isError: false,
        text: "status: reversed",
      },
  );
  const getAvailability = vi.fn(async () => options.availability ?? { undo: true, redo: false });
  return {
    app: {
      contextPorts: {
        forProject: vi.fn(() => ({
          read: vi.fn(async () => ({ ok: true, value: { documentId, content: "Alpha" } })),
        })),
      },
      threadRepos: {
        threads: {
          findById: vi.fn(async () => ({
            id: threadId,
            userId: options.threadUserId ?? userId,
            projectId: "project-1",
          })),
        },
        threadWorks: {
          findPrimary: vi.fn(async () => null),
          listByThread: vi.fn(async () => []),
        },
      },
      documentSync: {
        agentEdit: () => ({ reverse, getAvailability }),
        refreshDocumentProjection: vi.fn(async (input) => {
          refreshed.push(input);
        }),
      },
    },
    reverse,
    getAvailability,
    refreshed,
  };
}

describe("thread context reverse routes", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.requireAppUser.mockReset();
  });

  it("requires auth for reverse", async () => {
    auth.requireAppUser.mockRejectedValue(
      Object.assign(new Error("unauthorized"), { statusCode: 401 }),
    );
    const route = (await import("./reverse.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(route({ params: { threadId }, body: {} })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("returns 404 for a thread owned by another user", async () => {
    const { app } = makeApp({ threadUserId: "user-2" });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./reverse.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(
      route({
        params: { threadId },
        body: { uri: "manuscript://chapter.md", direction: "undo", scope: "write" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("accepts a happy-path user undo and refreshes projection", async () => {
    const { app, reverse, refreshed } = makeApp();
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./reverse.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;
    const event: TestEvent = {
      params: { threadId },
      body: { uri: "manuscript://chapter.md", direction: "undo", scope: "turn", target: "turn-1" },
    };

    const response = await route(event);

    expect(event.status).toBe(202);
    expect(response).toMatchObject({ status: "reversed" });
    expect(reverse).toHaveBeenCalledWith({
      docId: documentId,
      threadId,
      direction: "undo",
      scope: "turn",
      target: "turn-1",
      actor: { type: "user", userId },
    });
    expect(refreshed).toEqual([{ documentId, threadId }]);
  });

  it("maps dependent undo refusal to 409", async () => {
    const { app } = makeApp({
      reverseOutcome: {
        command: "undo",
        status: "cant_undo_dependent",
        isError: true,
        text: "status: cant_undo_dependent",
      },
    });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./reverse.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(
      route({
        params: { threadId },
        body: { uri: "manuscript://chapter.md", direction: "undo", scope: "write", target: "w1" },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("returns availability flags", async () => {
    const availability = { undo: true, redo: true, undoWriteId: "w2", redoWriteId: "w1" };
    const { app, getAvailability } = makeApp({ availability });
    auth.requireAppUser.mockResolvedValue({ app, user: { userId } });
    const route = (await import("./reverse-availability.get.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    const response = await route({
      params: { threadId },
      query: { uri: "manuscript://chapter.md" },
    });

    expect(response).toEqual(availability);
    expect(getAvailability).toHaveBeenCalledWith(documentId, threadId);
  });
});
