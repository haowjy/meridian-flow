import type { EventRecord } from "@meridian/contracts/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import { meridianTraceAPI } from "./agent-trace-api";
import {
  appendTraceEvent,
  clearTraceEvents,
  noteTapError,
  TRACE_STORE_CAPACITY,
} from "./trace-store";

function event(observerSeq: number, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    timestamp: new Date(observerSeq).toISOString(),
    level: "trace",
    source: "wire.yjs",
    name: "frame",
    stream: {
      streamId: "yjs:live:document-a",
      transport: "yjs",
      observedAt: "client",
      direction: "client_to_server",
      messageClass: "sync.update",
      observerSeq,
    },
    payload: {},
    ...overrides,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  clearTraceEvents();
  await Promise.resolve();
});

describe("agent trace API", () => {
  it("returns events matching composable metadata filters", () => {
    appendTraceEvent(event(1));
    appendTraceEvent(
      event(2, {
        stream: {
          streamId: "yjs:branch:revision-b",
          transport: "yjs",
          observedAt: "server",
          direction: "server_to_client",
          messageClass: "sync.step2",
          observerSeq: 2,
        },
      }),
    );
    appendTraceEvent(event(3, { stream: undefined }));

    expect(meridianTraceAPI.getEvents()).toHaveLength(3);
    expect(
      meridianTraceAPI
        .getEvents({
          transport: "yjs",
          messageClass: "sync.step2",
          direction: "server_to_client",
          stream: "yjs:branch:",
        })
        .map((record) => record.stream?.observerSeq),
    ).toEqual([2]);
  });

  it("reports total captured events, ring drops, and tap errors", () => {
    for (let index = 0; index <= TRACE_STORE_CAPACITY; index += 1) {
      appendTraceEvent(event(index));
    }
    noteTapError();

    expect(meridianTraceAPI.getStats()).toEqual({
      captured: TRACE_STORE_CAPACITY + 1,
      ringDropped: 1,
      tapErrors: 1,
    });
  });

  it("waits for the first new matching event", async () => {
    appendTraceEvent(event(1));
    const waiting = meridianTraceAPI.waitForEvent({ messageClass: "sync.status" });

    appendTraceEvent(event(2));
    appendTraceEvent(
      event(3, {
        stream: {
          streamId: "yjs:live:document-a",
          transport: "yjs",
          observedAt: "client",
          direction: "server_to_client",
          messageClass: "sync.status",
          observerSeq: 3,
        },
      }),
    );

    await expect(waiting).resolves.toMatchObject({ stream: { observerSeq: 3 } });
  });

  it("returns null when no matching event arrives before the timeout", async () => {
    vi.useFakeTimers();
    const waiting = meridianTraceAPI.waitForEvent({ transport: "thread-ws" }, 25);

    await vi.advanceTimersByTimeAsync(25);

    await expect(waiting).resolves.toBeNull();
  });

  it("does not resolve with an event captured before the wait began", async () => {
    vi.useFakeTimers();
    appendTraceEvent(event(1));
    const waiting = meridianTraceAPI.waitForEvent({ messageClass: "sync.update" }, 25);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    await expect(waiting).resolves.toBeNull();
  });

  it("observes the first matching event when clear and new captures publish together", async () => {
    vi.useFakeTimers();
    appendTraceEvent(event(1));
    const waiting = meridianTraceAPI.waitForEvent({ messageClass: "sync.status" }, 25);

    meridianTraceAPI.clear();
    appendTraceEvent(
      event(2, {
        stream: {
          streamId: "yjs:live:document-a",
          transport: "yjs",
          observedAt: "client",
          direction: "server_to_client",
          messageClass: "sync.status",
          observerSeq: 2,
        },
      }),
    );
    appendTraceEvent(event(3));
    await Promise.resolve();

    await expect(waiting).resolves.toMatchObject({ stream: { observerSeq: 2 } });
  });

  it("clears events and counters", () => {
    appendTraceEvent(event(1));
    noteTapError();

    meridianTraceAPI.clear();

    expect(meridianTraceAPI.getEvents()).toEqual([]);
    expect(meridianTraceAPI.getStats()).toEqual({ captured: 0, ringDropped: 0, tapErrors: 0 });
  });
});
