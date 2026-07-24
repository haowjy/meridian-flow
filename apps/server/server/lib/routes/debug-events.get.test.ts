/** Recent-events query route coverage for filter delegation and disabled gating. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type EventQuery, RecentEventsBuffer } from "../../domains/observability/index.js";

const mocks = vi.hoisted(() => ({
  eventQuery: undefined as EventQuery | undefined,
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

  it("filters gateway calls by exact correlation id", async () => {
    const events = new RecentEventsBuffer();
    events.emit({
      eventId: "other-call",
      timestamp: "2026-07-18T00:00:00.000Z",
      level: "info",
      source: "gateway",
      name: "stream.close",
      correlation: { gatewayCallId: "call-2" },
      payload: {},
    });
    events.emit({
      eventId: "matching-call",
      timestamp: "2026-07-18T00:00:01.000Z",
      level: "info",
      source: "gateway",
      name: "stream.close",
      correlation: { gatewayCallId: "call-1" },
      payload: {},
    });
    mocks.eventQuery = events;
    mocks.query = { gatewayCallId: "call-1" };

    await expect(handler({})).resolves.toMatchObject({
      events: [{ eventId: "matching-call" }],
    });

    mocks.query = { gatewayCallId: "unknown" };
    await expect(handler({})).resolves.toMatchObject({ events: [] });
  });

  it("returns 404 when the query surface is absent", async () => {
    mocks.eventQuery = undefined;

    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 });
  });
});
