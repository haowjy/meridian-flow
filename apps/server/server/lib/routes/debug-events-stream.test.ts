/** Recent-events SSE route coverage for live filtering, frames, and cleanup. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../../domains/observability/index.js";

const mocks = vi.hoisted(() => ({
  closed: undefined as (() => void) | undefined,
  listener: undefined as ((event: EventRecord) => void) | undefined,
  push: vi.fn(async (_frame: { data: string; id?: string }) => undefined),
  pushComment: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  send: vi.fn(() => "sse-body"),
  unsubscribe: vi.fn(),
}));

vi.mock("nitro/h3", () => ({
  createError: ({ statusCode, message }: { statusCode: number; message: string }) =>
    Object.assign(new Error(message), { statusCode }),
  createEventStream: () => ({
    push: mocks.push,
    pushComment: mocks.pushComment,
    close: mocks.close,
    send: mocks.send,
    onClosed: (listener: () => void) => {
      mocks.closed = listener;
    },
  }),
  defineEventHandler: (handler: unknown) => handler,
  getQuery: () => ({ source: "wire.yjs", documentId: "doc" }),
}));
vi.mock("../auth-gate.js", () => ({
  requireAppUser: async () => ({
    app: {
      eventQuery: {
        query: vi.fn(),
        subscribe: (listener: (event: EventRecord) => void) => {
          mocks.listener = listener;
          return mocks.unsubscribe;
        },
      },
    },
  }),
}));

const handler = (await import("../../routes/api/debug/events/stream.get.js")).default as (
  event: unknown,
) => Promise<unknown>;

beforeEach(() => {
  mocks.push.mockResolvedValue(undefined);
  mocks.closed = undefined;
  mocks.listener = undefined;
});

afterEach(() => {
  mocks.closed?.();
  vi.clearAllMocks();
});

describe("GET /api/debug/events/stream", () => {
  it("emits filtered live records as id plus JSON data and unsubscribes on close", async () => {
    const request = new AbortController();
    await expect(handler({ req: { signal: request.signal } })).resolves.toBe("sse-body");
    const matching: EventRecord = {
      eventId: "event-1",
      timestamp: "2026-07-18T00:00:00.000Z",
      level: "info",
      source: "wire.yjs",
      name: "frame.received",
      correlation: { documentId: "doc" },
      payload: { bytes: 10 },
    };
    mocks.listener?.({ ...matching, correlation: { documentId: "other" } });
    mocks.listener?.(matching);

    expect(mocks.push).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledWith({ id: "event-1", data: JSON.stringify(matching) });

    request.abort();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it("serializes stalled writes and closes exactly when the pending queue overflows", async () => {
    const request = new AbortController();
    const pendingPushes: Array<() => void> = [];
    mocks.push.mockImplementation(
      () => new Promise<undefined>((resolve) => pendingPushes.push(() => resolve(undefined))),
    );
    await handler({ req: { signal: request.signal } });
    const record = (sequence: number): EventRecord => ({
      eventId: `event-${sequence}`,
      timestamp: "2026-07-18T00:00:00.000Z",
      level: "info",
      source: "wire.yjs",
      name: "frame.received",
      correlation: { documentId: "doc" },
      payload: { sequence },
    });

    mocks.listener?.(record(0));
    mocks.listener?.(record(1));
    mocks.listener?.(record(2));
    expect(mocks.push).toHaveBeenCalledOnce();

    pendingPushes[0]?.();
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(2));
    expect(mocks.push.mock.calls.map(([frame]) => JSON.parse(frame.data).eventId)).toEqual([
      "event-0",
      "event-1",
    ]);

    for (let index = 3; index < 1_002; index += 1) mocks.listener?.(record(index));
    expect(mocks.close).not.toHaveBeenCalled();
    mocks.listener?.(record(1_002));

    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledTimes(2);

    request.abort();
    mocks.closed?.();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });
});
