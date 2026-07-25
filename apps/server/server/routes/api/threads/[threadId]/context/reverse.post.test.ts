/** Transport parity coverage for the thread-context reversal command. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  body: undefined as unknown,
  reverseThreadContext: vi.fn(),
  setResponseStatus: vi.fn(),
}));
const THREAD_ID = "00000000-0000-0000-0000-000000000001";

vi.mock("nitro/h3", () => ({
  createError: (input: { statusCode: number; message?: string }) =>
    Object.assign(new Error(input.message), input),
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: () => THREAD_ID,
  readBody: async () => mocks.body,
  setResponseStatus: mocks.setResponseStatus,
}));
vi.mock("../../../../../domains/collab/index.js", () => ({
  ReverseThreadContextError: class ReverseThreadContextError extends Error {},
}));
vi.mock("../../../../../lib/auth-gate.js", () => ({
  requireAppUser: async () => ({
    app: { documentSync: { reverseThreadContext: mocks.reverseThreadContext } },
    user: { userId: "user-1" },
  }),
}));

const handler = (await import("./reverse.post.js")).default as unknown as (
  event: unknown,
) => Promise<unknown>;

beforeEach(() => {
  mocks.reverseThreadContext.mockReset();
  mocks.reverseThreadContext.mockResolvedValue({ status: "reversed", documents: [] });
  mocks.setResponseStatus.mockReset();
});

describe("thread-context reversal body parity", () => {
  it.each([
    ["undo write", { uri: "manuscript://chapter.md", direction: "undo", scope: "write" }],
    ["redo write", { uri: "manuscript://chapter.md", direction: "redo", scope: "write" }],
    ["undo turn", { direction: "undo", scope: "turn", target: "turn-1" }],
    ["redo turn", { direction: "redo", scope: "turn", target: "turn-1" }],
    ["undo thread", { uri: "manuscript://chapter.md", direction: "undo", scope: "thread" }],
    ["redo thread", { uri: "manuscript://chapter.md", direction: "redo", scope: "thread" }],
  ])("accepts the valid %s body", async (_name, body) => {
    mocks.body = body;

    await expect(handler({})).resolves.toEqual({ status: "reversed", documents: [] });

    expect(mocks.reverseThreadContext).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: body.direction,
        scope: body.scope,
        threadId: THREAD_ID,
        userId: "user-1",
      }),
    );
  });

  it.each([
    ["array", []],
    ["string", "undo"],
    ["number", 1],
    ["boolean", true],
    ["null", null],
  ])("preserves the old message for a top-level %s body", async (_name, body) => {
    mocks.body = body;

    await expect(handler({})).rejects.toMatchObject({
      statusCode: 400,
      message: "direction must be undo or redo",
    });
    expect(mocks.reverseThreadContext).not.toHaveBeenCalled();
  });
});
