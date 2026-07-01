import { beforeEach, describe, expect, it, vi } from "vitest";

const routeCore = vi.hoisted(() => ({
  requireAppUser: vi.fn(),
  selectDraftRouteServices: vi.fn(),
  handleDraftPreviewRequest: vi.fn(),
  handleDraftAcceptRequest: vi.fn(),
}));

vi.mock("../../../../../../../lib/auth-gate.js", () => ({
  requireAppUser: routeCore.requireAppUser,
}));
vi.mock("../../../../../../../../lib/auth-gate.js", () => ({
  requireAppUser: routeCore.requireAppUser,
}));

vi.mock("../../../../../../../lib/draft-review-route.js", () => ({
  selectDraftRouteServices: routeCore.selectDraftRouteServices,
  handleDraftPreviewRequest: routeCore.handleDraftPreviewRequest,
  handleDraftAcceptRequest: routeCore.handleDraftAcceptRequest,
}));
vi.mock("../../../../../../../../lib/draft-review-route.js", () => ({
  selectDraftRouteServices: routeCore.selectDraftRouteServices,
  handleDraftPreviewRequest: routeCore.handleDraftPreviewRequest,
  handleDraftAcceptRequest: routeCore.handleDraftAcceptRequest,
}));

vi.mock("nitro/h3", () => ({
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (event: { params?: Record<string, string> }, name: string) =>
    event.params?.[name],
  getQuery: (event: { query?: Record<string, unknown> }) => event.query ?? {},
  readBody: (event: { body?: unknown }) => event.body ?? {},
}));

type TestEvent = {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
};

const app = { app: true };
const services = { services: true };
const threadId = "thread-1";
const documentId = "doc-1";
const userId = "user-1";

describe("thread document draft route wrappers", () => {
  beforeEach(() => {
    vi.resetModules();
    routeCore.requireAppUser.mockReset();
    routeCore.selectDraftRouteServices.mockReset();
    routeCore.handleDraftPreviewRequest.mockReset();
    routeCore.handleDraftAcceptRequest.mockReset();
    routeCore.requireAppUser.mockResolvedValue({ app, user: { userId } });
    routeCore.selectDraftRouteServices.mockReturnValue(services);
  });

  it("passes route params and string draftId query to the preview core", async () => {
    routeCore.handleDraftPreviewRequest.mockResolvedValue({ status: "gone", live: "Live" });
    const route = (await import("./index.get.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(
      route({ params: { threadId, documentId }, query: { draftId: "draft-1" } }),
    ).resolves.toEqual({ status: "gone", live: "Live" });

    expect(routeCore.handleDraftPreviewRequest).toHaveBeenCalledWith(services, {
      threadId,
      documentId,
      draftId: "draft-1",
      userId,
    });
  });

  it("passes overlap confirmation body fields to the accept core", async () => {
    routeCore.handleDraftAcceptRequest.mockResolvedValue({
      status: "applied",
      draftId: "draft-1",
      appliedUpdateSeq: 42,
      acceptTurnId: "turn-accept",
    });
    const route = (await import("./accept/index.post.js")).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>;

    await expect(
      route({
        params: { threadId, documentId },
        body: { draftId: "draft-1", confirmOverlap: true, confirmedLiveRevisionToken: 7 },
      }),
    ).resolves.toEqual({
      status: "applied",
      draftId: "draft-1",
      appliedUpdateSeq: 42,
      acceptTurnId: "turn-accept",
    });

    expect(routeCore.handleDraftAcceptRequest).toHaveBeenCalledWith(services, {
      threadId,
      documentId,
      draftId: "draft-1",
      userId,
      confirmOverlap: true,
      confirmedLiveRevisionToken: 7,
    });
  });
});
