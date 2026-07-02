/** Route validation for AI draft accept requests. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readBody = vi.fn();
const handleDraftAcceptRequest = vi.fn();

vi.mock("nitro/h3", () => ({
  createError: (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), input),
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (_event: unknown, key: string) => `${key}-1`,
  readBody,
}));

vi.mock("../../../../../../../../lib/auth-gate.js", () => ({
  requireAppUser: vi.fn(async () => ({ app: {}, user: { userId: "user-1" } })),
}));

vi.mock("../../../../../../../../lib/draft-review-route.js", () => ({
  handleDraftAcceptRequest,
  selectDraftRouteServices: vi.fn(() => ({ services: true })),
}));

describe("draft accept route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing draft revision token", async () => {
    readBody.mockResolvedValue({ draftId: "draft-1" });
    const { default: handler } = await import("./index.post.js");

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "draftRevisionToken is required",
    });
    expect(handleDraftAcceptRequest).not.toHaveBeenCalled();
  });
});
