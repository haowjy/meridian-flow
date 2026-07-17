import type { EventRecord } from "@meridian/contracts/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendTraceEvent,
  clearTraceEvents,
  filterTraceEntries,
  getTraceSnapshot,
  noteTapError,
  subscribeToTraceEvents,
  subscribeToTraceStore,
  TRACE_STORE_CAPACITY,
  type TraceFilters,
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
  clearTraceEvents();
  await Promise.resolve();
});

describe("trace store", () => {
  it("keeps the newest bounded entries and counts every eviction", async () => {
    for (let index = 0; index < TRACE_STORE_CAPACITY + 3; index += 1) {
      appendTraceEvent(event(index));
    }
    await Promise.resolve();

    const current = getTraceSnapshot();
    expect(current.entries).toHaveLength(TRACE_STORE_CAPACITY);
    expect(current.entries[0]?.stream?.observerSeq).toBe(3);
    expect(current.entries.at(-1)?.stream?.observerSeq).toBe(TRACE_STORE_CAPACITY + 2);
    expect(current.ringDropped).toBe(3);
  });

  it("coalesces a burst into one notification with one combined snapshot", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToTraceStore(listener);
    const initial = getTraceSnapshot();

    expect(getTraceSnapshot()).toBe(initial);
    appendTraceEvent(event(1));
    appendTraceEvent(event(2));
    appendTraceEvent(event(3));
    noteTapError();
    await Promise.resolve();
    const combined = getTraceSnapshot();
    expect(combined).not.toBe(initial);
    expect(combined.entries.map((record) => record.stream?.observerSeq)).toEqual([1, 2, 3]);
    expect(combined.tapErrors).toBe(1);
    expect(getTraceSnapshot()).toBe(combined);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    appendTraceEvent(event(4));
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies per-event subscribers without letting them disrupt capture", () => {
    const listener = vi.fn();
    const unsubscribeThrowing = subscribeToTraceEvents(() => {
      throw new Error("consumer failed");
    });
    const unsubscribe = subscribeToTraceEvents(listener);

    expect(() => appendTraceEvent(event(1))).not.toThrow();
    expect(listener).toHaveBeenCalledWith(event(1));

    unsubscribe();
    unsubscribeThrowing();
  });

  it("clear resets entries and both counters", async () => {
    for (let index = 0; index <= TRACE_STORE_CAPACITY; index += 1) {
      appendTraceEvent(event(index));
    }
    noteTapError();
    await Promise.resolve();
    expect(getTraceSnapshot()).toMatchObject({ ringDropped: 1, tapErrors: 1 });

    clearTraceEvents();
    await Promise.resolve();

    expect(getTraceSnapshot()).toEqual({ entries: [], ringDropped: 0, tapErrors: 0 });
  });
});

describe("filterTraceEntries", () => {
  const defaults: TraceFilters = {
    streamId: "",
    messageClass: "",
    direction: "",
    correlation: "",
  };
  const entries = [
    event(1, { correlation: { documentId: "Novel-Alpha", branchId: "draft-main" } }),
    event(2, {
      stream: {
        streamId: "yjs:branch:revision-beta",
        transport: "yjs",
        observedAt: "server",
        direction: "server_to_client",
        messageClass: "sync.step2",
        observerSeq: 2,
      },
    }),
    event(3, { stream: undefined }),
  ];

  it.each([
    ["stream", { streamId: "yjs:branch:revision-beta" }, [2]],
    ["message class", { messageClass: "sync.update" }, [1]],
    ["direction", { direction: "server_to_client" as const }, [2]],
    ["document correlation", { correlation: "novel-alpha" }, [1]],
    ["branch correlation", { correlation: "DRAFT" }, [1]],
    ["stream correlation", { correlation: "revision-beta" }, [2]],
    ["composed filters", { messageClass: "sync.update", correlation: "draft-main" }, [1]],
  ])("filters by %s", (_label, filter, expectedSequences) => {
    const result = filterTraceEntries(entries, { ...defaults, ...filter });
    expect(result.map((record) => record.stream?.observerSeq)).toEqual(expectedSequences);
  });
});
