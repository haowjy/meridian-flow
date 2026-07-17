/** Runtime validation for selective draft Apply requests. */
import { expect, it, vi } from "vitest";

const { handleAccept } = vi.hoisted(() => ({ handleAccept: vi.fn() }));

vi.mock("nitro/h3", () => ({
  createError: (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), input),
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (_event: unknown, name: string) => `${name}-1`,
  readBody: async () => ({
    branchId: "branch-1",
    draftRevisionToken: 1,
    operationIds: [1],
  }),
}));
vi.mock("../../../../../../../../../../lib/auth-gate.js", () => ({
  requireAppUser: async () => ({ app: {}, user: { userId: "user-1" } }),
}));
vi.mock("../../../../../../../../../../lib/draft-review-route.js", () => ({
  handleWorkDraftAcceptRequest: handleAccept,
  selectDraftRouteServices: vi.fn(() => ({})),
}));

const handler = (await import("./index.post.js")).default as unknown as (event: {
  req: { signal: AbortSignal };
}) => Promise<unknown>;

it("rejects an operationIds array with no valid nonempty string", async () => {
  await expect(handler({ req: { signal: new AbortController().signal } })).rejects.toMatchObject({
    statusCode: 400,
  });
  expect(handleAccept).not.toHaveBeenCalled();
});
