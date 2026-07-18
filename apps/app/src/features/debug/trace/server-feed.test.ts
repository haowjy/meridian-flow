import type { EventRecord } from "@meridian/contracts/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getServerFeedState,
  startServerFeed,
  stopServerFeed,
  subscribeToServerFeed,
} from "./server-feed";
import { clearTraceEvents, getTraceSnapshot } from "./trace-store";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly options: EventSourceInit | undefined;
  readonly close = vi.fn();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;

  constructor(url: string | URL, options?: EventSourceInit) {
    this.url = url.toString();
    this.options = options;
    FakeEventSource.instances.push(this);
  }

  message(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>);
  }
}

const record: EventRecord = {
  eventId: "event-1",
  timestamp: "2026-07-18T12:00:00.000Z",
  level: "info",
  source: "runtime.orchestrator",
  name: "turn.started",
  stream: {
    streamId: "thread:thread-1",
    transport: "thread",
    observedAt: "server",
    observerSeq: 1,
  },
  payload: {},
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(async () => {
  stopServerFeed();
  clearTraceEvents();
  vi.unstubAllGlobals();
  await Promise.resolve();
});

describe("server feed", () => {
  it("appends valid SSE records to the shared trace ring", () => {
    startServerFeed();

    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe("/api/debug/events/stream");
    expect(source?.options).toEqual({ withCredentials: true });
    source?.message(JSON.stringify(record));

    expect(getTraceSnapshot().entries).toEqual([record]);
  });

  it("ignores malformed frames without breaking the feed", () => {
    startServerFeed();
    const source = FakeEventSource.instances[0];

    source?.message("not json");
    source?.message(JSON.stringify({ timestamp: record.timestamp, source: record.source }));
    expect(getTraceSnapshot().entries).toEqual([]);

    source?.message(JSON.stringify(record));
    expect(getTraceSnapshot().entries).toEqual([record]);
    expect(source?.close).not.toHaveBeenCalled();
  });

  it("closes and resets the observable connection state", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToServerFeed(listener);
    startServerFeed();
    const source = FakeEventSource.instances[0];

    expect(getServerFeedState()).toBe("connecting");
    source?.onopen?.();
    expect(getServerFeedState()).toBe("open");

    stopServerFeed();
    expect(source?.close).toHaveBeenCalledOnce();
    expect(getServerFeedState()).toBe("idle");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
