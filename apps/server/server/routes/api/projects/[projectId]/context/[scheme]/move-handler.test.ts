/** Route-level authorization, Work-scope, and destination wiring coverage. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextPort } from "../../../../../../domains/context/index.js";

const WORK_ID = "00000000-0000-4000-8000-000000000701";
const OTHER_WORK_ID = "00000000-0000-4000-8000-000000000702";

vi.mock("nitro/h3", () => ({
  createError: (input: Record<string, unknown>) =>
    Object.assign(new Error(String(input.message)), input),
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (event: { params: Record<string, string> }, name: string) => event.params[name],
  readBody: async (event: { body: unknown }) => event.body,
  setResponseStatus: (event: { status?: number }, status: number) => {
    event.status = status;
  },
}));

vi.mock("../../../../../../lib/auth-gate.js", () => ({
  requireAppUser: async (event: { app?: unknown; authError?: Error; userId?: string }) => {
    if (event.authError) throw event.authError;
    return { app: event.app, user: { userId: event.userId ?? "user-1" } };
  },
}));

const handler = (await import("./move.post.js")).default as unknown as (
  event: RouteEvent,
) => Promise<unknown>;

type RouteEvent = {
  params: { projectId: string; scheme: string };
  body: unknown;
  app?: ReturnType<typeof appFor>;
  userId?: string;
  authError?: Error;
  status?: number;
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    path: "Source.md",
    destinationScheme: "manuscript",
    destinationFolderPath: "Dest",
    ...overrides,
  };
}

function appFor(
  options: {
    projectUserId?: string;
    projectDeletedAt?: Date | null;
    works?: Record<string, { projectId: string; deletedAt?: Date | null }>;
  } = {},
) {
  const move = vi.fn<ContextPort["move"]>(async () => ({
    ok: true as const,
    value: { movedNodeId: "node-1", destinationPath: "Dest/Source.md" },
  }));
  const port = { move };
  return {
    projectRepo: {
      findById: vi.fn(async () => ({
        id: "project-1",
        userId: options.projectUserId ?? "user-1",
        deletedAt: options.projectDeletedAt ?? null,
      })),
    },
    workRepo: {
      findById: vi.fn(async (id: string) => {
        const work = options.works?.[id];
        return work ? { id, ...work } : null;
      }),
    },
    contextPorts: {
      forProject: vi.fn(() => port),
      forWork: vi.fn(() => port),
    },
    port,
  };
}

function event(app: ReturnType<typeof appFor>, requestBody = body(), scheme = "manuscript") {
  return { params: { projectId: "project-1", scheme }, body: requestBody, app } as RouteEvent;
}

beforeEach(() => vi.clearAllMocks());

describe("move context route gates", () => {
  it("propagates authentication rejection before route work", async () => {
    const authError = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    await expect(
      handler({
        params: { projectId: "project-1", scheme: "manuscript" },
        body: body(),
        authError,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it.each([
    ["foreign", { projectUserId: "other-user" }],
    ["soft-deleted", { projectDeletedAt: new Date() }],
  ])("rejects a %s project", async (_label, options) => {
    await expect(handler(event(appFor(options)))).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    ["missing", undefined],
    ["foreign", { projectId: "project-2", deletedAt: null }],
    ["deleted", { projectId: "project-1", deletedAt: new Date() }],
  ])("rejects a %s Work", async (_label, work) => {
    const app = appFor({ works: work ? { [WORK_ID]: work } : {} });
    await expect(
      handler(event(app, body({ sourceWorkId: WORK_ID }), "scratch")),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(app.contextPorts.forWork).not.toHaveBeenCalled();
  });

  it.each([
    ["project source with Work", "manuscript", { sourceWorkId: WORK_ID }],
    ["Work source without Work", "scratch", {}],
    ["project destination with Work", "manuscript", { destinationWorkId: WORK_ID }],
    ["Work destination without Work", "manuscript", { destinationScheme: "scratch" }],
  ])("rejects scheme–workId mismatch: %s", async (_label, scheme, overrides) => {
    await expect(handler(event(appFor(), body(overrides), scheme))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("moves into a Work-scoped scheme through a port authorized for that Work", async () => {
    const app = appFor({ works: { [OTHER_WORK_ID]: { projectId: "project-1" } } });
    app.port.move.mockResolvedValue({
      ok: true,
      value: { movedNodeId: "node-1", destinationPath: "Drafts/Source.md" },
    });

    await expect(
      handler(
        event(
          app,
          body({
            destinationScheme: "scratch",
            destinationFolderPath: "Drafts",
            destinationWorkId: OTHER_WORK_ID,
          }),
        ),
      ),
    ).resolves.toEqual({
      status: "moved",
      scheme: "scratch",
      path: "Drafts/Source.md",
      name: "Source.md",
    });
    expect(app.contextPorts.forWork).toHaveBeenCalledWith(
      OTHER_WORK_ID,
      "project-1",
      "user-1",
      new Set([OTHER_WORK_ID]),
    );
    expect(app.port.move).toHaveBeenCalledWith(
      "manuscript://Source.md",
      `scratch://${OTHER_WORK_ID}/Drafts/Source.md`,
      expect.objectContaining({ exactTarget: true }),
    );
  });

  it("shapes a collision as a stack-free 409 with its canonical locator", async () => {
    const app = appFor();
    app.port.move.mockResolvedValue({
      ok: false,
      error: { code: "conflict", uri: "manuscript://Dest/Source.md" },
    });
    const request = event(app);

    await expect(handler(request)).resolves.toEqual({
      status: "conflict",
      collision: { scheme: "manuscript", path: "Dest/Source.md" },
    });
    expect(request.status).toBe(409);
  });
});
