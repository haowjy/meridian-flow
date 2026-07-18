/** Recent-events query route coverage for filter delegation and disabled gating. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventQuery: undefined as
    | { query: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }
    | undefined,
  query: {} as Record<string, string>,
}));

vi.mock("nitro/h3", () => ({
  createError: ({ statusCode, message }: { statusCode: number; message: string }) =>
    Object.assign(new Error(message), { statusCode }),
  defineEventHandler: (handler: unknown) => handler,
  getQuery: () => mocks.query,
}));
vi.mock("../auth-gate.js", () => ({
  requireAppUser: async () => ({ app: { eventQuery: mocks.eventQuery } }),
}));

const handler = (await import("../../routes/api/debug/events.get.js")).default as (
  event: unknown,
) => Promise<unknown>;

describe("GET /api/debug/events", () => {
  beforeEach(() => {
    mocks.query = {};
    mocks.eventQuery = { query: vi.fn(() => ({ events: [], dropped: 0 })), subscribe: vi.fn() };
  });

  it("delegates parsed filters to EventQuery", async () => {
    mocks.query = { source: "wire.yjs", documentId: "doc", limit: "50" };

    await expect(handler({})).resolves.toEqual({ events: [], dropped: 0 });
    expect(mocks.eventQuery?.query).toHaveBeenCalledWith({
      source: "wire.yjs",
      correlation: { documentId: "doc" },
      limit: 50,
    });
  });

  it("returns 404 when the query surface is absent", async () => {
    mocks.eventQuery = undefined;

    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 });
  });
});
