/** Route-level regression matrix: malformed DB IDs stop at transport boundaries. */

import { parseWsServerMessage } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseNullableRequestId } from "../request-id.js";
import { createThreadWebSocketSession, type WsPeer } from "../ws-thread-handler.js";

const VALID_ID = "00000000-0000-0000-0000-000000000001";
const MALFORMED_ID = "not-a-uuid";
const CANONICAL_THREAD_ID = "abcdef00-0000-0000-0000-000000000001";
const CANONICAL_TURN_ID = "abcdef00-0000-0000-0000-000000000002";

vi.mock("nitro/h3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nitro/h3")>();
  return {
    ...actual,
    defineEventHandler: (handler: unknown) => handler,
    getRouterParam: (event: TestEvent, name: string) => event.params[name],
    readBody: async (event: TestEvent) => event.body,
    readMultipartFormData: async (event: TestEvent) => event.multipart,
    setResponseStatus: (event: TestEvent, status: number) => {
      event.res.status = status;
    },
  };
});

vi.mock("../auth-gate.js", () => ({
  requireAppUser: async (event: TestEvent) => event.auth,
}));

type TestHandler = (event: TestEvent) => Promise<unknown>;

type TestEvent = {
  params: Record<string, string>;
  body?: unknown;
  multipart?: unknown;
  res: { status: number };
  auth: { app: Record<string, unknown>; user: { userId: string } };
};

const databaseCall = vi.fn(async () => {
  throw new Error("database boundary was reached");
});

function event(
  params: Record<string, string>,
  body?: unknown,
  appOverrides: Record<string, unknown> = {},
): TestEvent {
  const projectRepo = { findById: databaseCall, create: databaseCall };
  const repos = {
    threads: { findById: databaseCall, listByWork: databaseCall },
    turns: { findById: databaseCall },
    threadWorks: {},
    blocks: {},
    threadDocuments: {},
    transaction: databaseCall,
  };
  return {
    params,
    body,
    res: { status: 200 },
    auth: {
      user: { userId: VALID_ID },
      app: {
        projectRepo,
        workRepo: {},
        repos,
        threadRepos: repos,
        threadRuntime: { requireOwnedThread: databaseCall },
        runner: { cancel: databaseCall },
        changeTrails: { readDetails: databaseCall },
        documentSync: {
          applyTrailForwardAction: databaseCall,
          listEditedDocumentsForTurn: databaseCall,
        },
        figureAssets: {
          getSignedFigureUrl: databaseCall,
          uploadFigure: databaseCall,
        },
        packageRepository: {},
        eventSink: {},
        journalWriter: {},
        ...appOverrides,
      },
    },
  };
}

async function expectBadRequest(result: Promise<unknown>): Promise<void> {
  await expect(result).rejects.toMatchObject({ statusCode: 400 });
  expect(databaseCall).not.toHaveBeenCalled();
}

const [
  snapshot,
  sendMessage,
  listWorkThreads,
  cancelTurn,
  liveLineage,
  trailDetail,
  restoreTrailChange,
  deleteTrailChangeAgain,
  uploadFigure,
  signedFigureUrl,
  createProject,
  createThread,
  createProjectThread,
  forkThread,
] = await Promise.all([
  import("../../routes/api/threads/[threadId]/snapshot.get.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import("../../routes/api/threads/[threadId]/messages.post.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import("../../routes/api/projects/[projectId]/works/[workId]/threads.get.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import("../../routes/api/threads/[threadId]/turns/[turnId]/cancel.post.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import("../../routes/api/threads/[threadId]/turns/[turnId]/live-lineage.get.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import("../../routes/api/threads/[threadId]/change-trails/[trailId].get.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import(
    "../../routes/api/threads/[threadId]/change-trails/[trailId]/changes/[changeId]/restore/index.post.js"
  ).then((module) => module.default as unknown as TestHandler),
  import(
    "../../routes/api/threads/[threadId]/change-trails/[trailId]/changes/[changeId]/delete-again/index.post.js"
  ).then((module) => module.default as unknown as TestHandler),
  import("../../routes/api/projects/[projectId]/documents/[documentId]/figure.post.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import(
    "../../routes/api/projects/[projectId]/documents/[documentId]/figure/signed-url.get.js"
  ).then((module) => module.default as unknown as TestHandler),
  import("../../routes/api/projects/index.post.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import("../../routes/api/threads/index.post.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import("../../routes/api/projects/[projectId]/threads/index.post.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
  import("../../routes/api/threads/[threadId]/fork/index.post.js").then(
    (module) => module.default as unknown as TestHandler,
  ),
]);

describe("malformed HTTP request IDs", () => {
  beforeEach(() => {
    databaseCall.mockClear();
  });

  it.each([
    ["owner-gated thread route", () => snapshot(event({ threadId: MALFORMED_ID }))],
    ["thread messages", () => sendMessage(event({ threadId: MALFORMED_ID }, { text: "hello" }))],
    [
      "work-thread list",
      () => listWorkThreads(event({ projectId: VALID_ID, workId: MALFORMED_ID })),
    ],
    ["turn cancel", () => cancelTurn(event({ threadId: VALID_ID, turnId: MALFORMED_ID }))],
    ["live-lineage", () => liveLineage(event({ threadId: VALID_ID, turnId: MALFORMED_ID }))],
    [
      "change-trail detail",
      () => trailDetail(event({ threadId: VALID_ID, trailId: MALFORMED_ID })),
    ],
    [
      "change-trail restore",
      () =>
        restoreTrailChange(
          event({ threadId: VALID_ID, trailId: MALFORMED_ID, changeId: "change-1" }),
        ),
    ],
    [
      "change-trail delete-again",
      () =>
        deleteTrailChangeAgain(
          event({ threadId: VALID_ID, trailId: MALFORMED_ID, changeId: "change-1" }),
        ),
    ],
    ["figure upload", () => uploadFigure(event({ projectId: VALID_ID, documentId: MALFORMED_ID }))],
    [
      "figure signed URL",
      () => signedFigureUrl(event({ projectId: VALID_ID, documentId: MALFORMED_ID })),
    ],
    [
      "project create client ID",
      () => createProject(event({}, { id: MALFORMED_ID, title: "Project" })),
    ],
    [
      "global thread create client ID",
      () => createThread(event({}, { id: MALFORMED_ID, projectId: VALID_ID })),
    ],
    ["global thread create project ID", () => createThread(event({}, { projectId: MALFORMED_ID }))],
    [
      "global thread create work ID",
      () => createThread(event({}, { projectId: VALID_ID, workId: MALFORMED_ID })),
    ],
    [
      "project-scoped thread create client ID",
      () => createProjectThread(event({ projectId: VALID_ID }, { id: MALFORMED_ID })),
    ],
    [
      "project-scoped thread create work ID",
      () =>
        createProjectThread(event({ projectId: VALID_ID }, { id: VALID_ID, workId: MALFORMED_ID })),
    ],
    [
      "thread fork origin turn",
      () =>
        forkThread(
          event({ threadId: VALID_ID }, { targetAgent: null, originTurnId: MALFORMED_ID }),
        ),
    ],
  ])("%s returns 400 before a database call", async (_surface, invoke) => {
    await expectBadRequest(invoke());
  });

  it("propagates normalized thread and turn IDs below the owner gate", async () => {
    const cancel = vi.fn(async () => "cancelled");
    const thread = {
      id: CANONICAL_THREAD_ID,
      projectId: VALID_ID,
      userId: VALID_ID,
      deletedAt: null,
    };
    const result = await cancelTurn(
      event(
        {
          threadId: CANONICAL_THREAD_ID.toUpperCase(),
          turnId: CANONICAL_TURN_ID.toUpperCase(),
        },
        undefined,
        {
          repos: { threads: { findById: vi.fn(async () => thread) } },
          projectRepo: {
            findById: vi.fn(async () => ({
              id: VALID_ID,
              userId: VALID_ID,
              deletedAt: null,
            })),
          },
          runner: { cancel },
        },
      ),
    );

    expect(cancel).toHaveBeenCalledWith(CANONICAL_THREAD_ID, CANONICAL_TURN_ID);
    expect(result).toEqual({
      threadId: CANONICAL_THREAD_ID,
      turnId: CANONICAL_TURN_ID,
      status: "cancelled",
    });
  });

  it("preserves nullable fork origin semantics", () => {
    expect(parseNullableRequestId(null, "originTurnId")).toBeNull();
  });
});

describe("malformed WebSocket thread IDs", () => {
  it.each([
    { type: "subscribe", threadId: MALFORMED_ID },
    { type: "resume", subscriptions: [{ threadId: MALFORMED_ID, lastSeq: "0" }] },
    { type: "unsubscribe", threadId: MALFORMED_ID },
    {
      type: "interrupt.respond",
      threadId: MALFORMED_ID,
      turnId: VALID_ID,
      interruptId: "interrupt-1",
      value: null,
    },
    {
      type: "interrupt.respond",
      threadId: VALID_ID,
      turnId: MALFORMED_ID,
      interruptId: "interrupt-1",
      value: null,
    },
  ])("$type returns transport not-found before a database call", async (message) => {
    const sent: string[] = [];
    const requireOwnedThread = vi.fn();
    const expectedThreadId =
      message.type === "interrupt.respond" && message.threadId === VALID_ID
        ? VALID_ID
        : MALFORMED_ID;
    const peer = {
      request: new Request("https://app.localhost/api/threads/ws"),
      context: {
        userId: VALID_ID,
        app: { threadRuntime: { requireOwnedThread } },
      },
      send: (frame: string) => sent.push(frame),
      close: vi.fn(),
    } as unknown as WsPeer;

    await createThreadWebSocketSession(peer).onMessage(JSON.stringify(message));

    expect(requireOwnedThread).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(parseWsServerMessage(sent[0] ?? "")).toMatchObject({
      type: "error",
      error: { code: "not_found" },
      threadId: expectedThreadId,
    });
  });

  it("normalizes interrupt thread and turn IDs before registry correlation", async () => {
    const resolve = vi.fn(() => ({ ok: true }));
    const peer = {
      request: new Request("https://app.localhost/api/threads/ws"),
      context: {
        userId: VALID_ID,
        app: {
          threadRuntime: { requireOwnedThread: vi.fn() },
          interruptRegistry: { resolve },
        },
      },
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WsPeer;

    await createThreadWebSocketSession(peer).onMessage(
      JSON.stringify({
        type: "interrupt.respond",
        threadId: CANONICAL_THREAD_ID.toUpperCase(),
        turnId: CANONICAL_TURN_ID.toUpperCase(),
        interruptId: "interrupt-1",
        value: null,
      }),
    );

    expect(resolve).toHaveBeenCalledWith({
      threadId: CANONICAL_THREAD_ID,
      turnId: CANONICAL_TURN_ID,
      interruptId: "interrupt-1",
      value: null,
    });
  });
});
