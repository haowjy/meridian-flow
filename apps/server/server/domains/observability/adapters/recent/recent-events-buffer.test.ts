/** RecentEventsBuffer behavior tests for bounded storage, filtering, and live delivery. */
import { describe, expect, it, vi } from "vitest";
import type { EventLevel, EventRecord } from "../../ports/event-sink.js";
import { RecentEventsBuffer } from "./recent-events-buffer.js";

function event(
  id: string,
  overrides: Partial<Omit<EventRecord, "eventId" | "payload">> & {
    payload?: Record<string, unknown>;
  } = {},
): EventRecord {
  return {
    eventId: id,
    timestamp: "2026-07-18T00:00:00.000Z",
    level: "info",
    source: "test",
    name: "event",
    payload: {},
    ...overrides,
  };
}

describe("RecentEventsBuffer", () => {
  it("evicts oldest records and counts lifetime drops", () => {
    const buffer = new RecentEventsBuffer(3);
    buffer.emitBatch([event("1"), event("2"), event("3"), event("4"), event("5")]);

    expect(buffer.query({})).toMatchObject({
      events: [{ eventId: "5" }, { eventId: "4" }, { eventId: "3" }],
      dropped: 2,
    });
  });

  it("orders newest-first and defaults the limit to 200", () => {
    const buffer = new RecentEventsBuffer();
    for (let index = 0; index < 250; index += 1) buffer.emit(event(String(index)));

    const result = buffer.query({});
    expect(result.events).toHaveLength(200);
    expect(result.events[0]?.eventId).toBe("249");
    expect(result.events.at(-1)?.eventId).toBe("50");
    expect(buffer.query({ limit: 2 }).events.map(({ eventId }) => eventId)).toEqual(["249", "248"]);
  });

  it("filters source exactly, name by prefix, and level by severity floor", () => {
    const buffer = new RecentEventsBuffer();
    const levels: EventLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
    for (const level of levels) {
      buffer.emit(event(level, { level, source: level === "fatal" ? "other" : "wire.yjs" }));
    }
    buffer.emit(event("prefix", { source: "wire.yjs.child", name: "socket.opened" }));
    buffer.emit(event("exact", { source: "wire.yjs", name: "socket.closed" }));

    expect(buffer.query({ source: "wire.yjs" }).events.map(({ eventId }) => eventId)).not.toContain(
      "prefix",
    );
    expect(buffer.query({ name: "socket." }).events.map(({ eventId }) => eventId)).toEqual([
      "exact",
      "prefix",
    ]);
    expect(buffer.query({ level: "warn" }).events.map(({ level }) => level)).toEqual([
      "fatal",
      "error",
      "warn",
    ]);
  });

  it("requires equality on every provided correlation key", () => {
    const buffer = new RecentEventsBuffer();
    buffer.emit(event("wrong-thread", { correlation: { documentId: "doc", threadId: "other" } }));
    buffer.emit(event("match", { correlation: { documentId: "doc", threadId: "thread" } }));
    buffer.emit(
      event("wrong-document", { correlation: { documentId: "other", threadId: "thread" } }),
    );

    expect(
      buffer
        .query({ correlation: { documentId: "doc", threadId: "thread" } })
        .events.map(({ eventId }) => eventId),
    ).toEqual(["match"]);
  });

  it("applies exclusive event-id and inclusive timestamp cursors", () => {
    const buffer = new RecentEventsBuffer();
    buffer.emit(event("old", { timestamp: "2026-07-18T00:00:00.000Z" }));
    buffer.emit(event("cursor", { timestamp: "2026-07-18T00:00:01.000Z" }));
    buffer.emit(event("same-time", { timestamp: "2026-07-18T00:00:01.000Z" }));
    buffer.emit(event("new", { timestamp: "2026-07-18T00:00:02.000Z" }));

    expect(buffer.query({ sinceEventId: "cursor" }).events.map(({ eventId }) => eventId)).toEqual([
      "new",
      "same-time",
    ]);
    expect(
      buffer
        .query({ sinceTimestamp: "2026-07-18T00:00:01.000Z" })
        .events.map(({ eventId }) => eventId),
    ).toEqual(["new", "same-time", "cursor"]);
  });

  it("publishes the sanitized inserted record and supports unsubscribe", () => {
    const buffer = new RecentEventsBuffer();
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);
    const unsafe = event("unsafe", { payload: { token: "secret", visible: "ok" } });

    buffer.emit(unsafe);
    const stored = buffer.query({}).events[0];
    expect(stored).toMatchObject({ payload: { token: "[redacted]", visible: "ok" } });
    expect(listener).toHaveBeenCalledWith(stored);
    expect(stored).not.toBe(unsafe);

    unsubscribe();
    buffer.emit(event("after"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates listeners that throw", () => {
    const buffer = new RecentEventsBuffer();
    buffer.subscribe(() => {
      throw new Error("listener failed");
    });
    const listener = vi.fn();
    buffer.subscribe(listener);

    expect(() => buffer.emit(event("safe"))).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
  });
});
