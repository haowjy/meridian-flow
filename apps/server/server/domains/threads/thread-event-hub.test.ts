import { EventType } from "@meridian/contracts/protocol";
import { SIMPLE_TEXT_TURN_ORCHESTRATOR, type Turn } from "@meridian/contracts/threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryEventSink } from "../observability/index.js";
import { createThreadEventHub } from "./thread-event-hub.js";

function mockJournalDeps() {
  return {
    journalWriter: {
      appendEvent: vi.fn(async () => 1n),
    },
    journalReader: {
      readAfter: vi.fn(async () => []),
      headSeq: vi.fn(async () => 0n),
      readModelProjectionWatermark: vi.fn(async () => 0n),
      listByThread: vi.fn(async () => []),
      listByType: vi.fn(async () => []),
      listSince: vi.fn(async () => []),
      listByTimeRange: vi.fn(async () => []),
    },
    eventSink: createInMemoryEventSink(),
  };
}

function assistantTurn(id: string, threadId: string, status: Turn["status"] = "streaming"): Turn {
  return {
    id,
    threadId,
    parentTurnId: null,
    role: "assistant",
    status,
    agentDefinitionId: "agent_test",
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0.000000",
    totalMillicredits: "0",
    responseCount: 0,
    usage: null,
    error: null,
    requestParams: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: status === "streaming" ? null : "2026-01-01T00:00:01.000Z",
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

describe("createThreadEventHub eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts per-thread state after grace when the last listener unsubscribes", () => {
    const hub = createThreadEventHub(mockJournalDeps(), { evictionGraceMs: 60_000 });
    const threadId = "thread_1";
    const listener = vi.fn();

    const unsubscribe = hub.subscribe(threadId, listener);
    expect(hub.hasThreadState(threadId)).toBe(true);

    unsubscribe();
    expect(hub.hasThreadState(threadId)).toBe(true);

    vi.advanceTimersByTime(59_999);
    expect(hub.hasThreadState(threadId)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(hub.hasThreadState(threadId)).toBe(false);
  });

  it("cancels eviction when a thread is resubscribed within the grace window", () => {
    const hub = createThreadEventHub(mockJournalDeps(), { evictionGraceMs: 60_000 });
    const threadId = "thread_1";

    hub.subscribe(threadId, vi.fn())();
    vi.advanceTimersByTime(30_000);

    const unsub2 = hub.subscribe(threadId, vi.fn());
    vi.advanceTimersByTime(60_000);
    expect(hub.hasThreadState(threadId)).toBe(true);

    unsub2();
    vi.advanceTimersByTime(60_000);
    expect(hub.hasThreadState(threadId)).toBe(false);
  });

  it("schedules eviction from catchupAndSubscribe unsubscribe", async () => {
    const hub = createThreadEventHub(mockJournalDeps(), { evictionGraceMs: 1_000 });
    const { unsubscribe } = await hub.catchupAndSubscribe("thread_2", 0n, vi.fn());

    unsubscribe();
    vi.advanceTimersByTime(1_000);
    expect(hub.hasThreadState("thread_2")).toBe(false);
  });

  it("evicts thread state created only by appendEvent with no listeners", async () => {
    const hub = createThreadEventHub(mockJournalDeps(), { evictionGraceMs: 5_000 });
    await hub.appendEvent("thread_orphan", SIMPLE_TEXT_TURN_ORCHESTRATOR[0]);

    expect(hub.hasThreadState("thread_orphan")).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(hub.hasThreadState("thread_orphan")).toBe(false);
  });

  it("preserves projector state after hot event state eviction", async () => {
    const hub = createThreadEventHub(mockJournalDeps(), { evictionGraceMs: 5_000 });
    const received = vi.fn();

    await hub.appendEvent("thread_projector", SIMPLE_TEXT_TURN_ORCHESTRATOR[0]);
    vi.advanceTimersByTime(5_000);
    expect(hub.hasThreadState("thread_projector")).toBe(false);

    hub.subscribe("thread_projector", received);
    await hub.appendEvent("thread_projector", SIMPLE_TEXT_TURN_ORCHESTRATOR[1]);

    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "turn_golden_asst_text::0",
        }),
      }),
    );
  });
});

describe("createThreadEventHub catchupAndSubscribe", () => {
  it("merges live appendEvent fan-out that occurs during journal replay into catchup", async () => {
    const deps = mockJournalDeps();
    let releaseRead!: () => void;
    deps.journalReader.readAfter = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseRead = () => resolve([]);
        }),
    );

    const hub = createThreadEventHub(deps);
    const pending = hub.catchupAndSubscribe("thread_buf", 0n, vi.fn());
    await hub.appendEvent("thread_buf", SIMPLE_TEXT_TURN_ORCHESTRATOR[0]);
    releaseRead();

    const { catchup } = await pending;
    expect(catchup.length).toBeGreaterThan(0);
  });
});

describe("createThreadEventHub fanout", () => {
  it("attaches turn.error envelope to RUN_ERROR frames and emits it to EventSink", async () => {
    const deps = mockJournalDeps();
    const eventSink = createInMemoryEventSink();
    const hub = createThreadEventHub({ ...deps, eventSink });
    const received = vi.fn();
    hub.subscribe("thread_error", received);
    const error = {
      code: "runtime_error",
      message: "model failed",
      retryable: false,
      source: "system" as const,
    };

    await hub.appendEvent("thread_error", {
      type: "turn.created",
      turn: assistantTurn("turn_error", "thread_error"),
    });
    await hub.appendEvent("thread_error", {
      type: "turn.error",
      turn: assistantTurn("turn_error", "thread_error", "error"),
      error,
    });

    expect(received).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: EventType.RUN_ERROR, message: "model failed" }),
        error,
      }),
    );
    expect(eventSink.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "threads.event-hub",
        name: "turn.error",
        payload: expect.objectContaining({ threadId: "thread_error", turnId: "turn_error", error }),
      }),
    );
  });

  it("isolates throwing listeners from appendEvent and other listeners", async () => {
    const eventSink = createInMemoryEventSink();
    const deps = mockJournalDeps();
    const hub = createThreadEventHub({ ...deps, eventSink });
    const received = vi.fn();

    // Establish the active run first (turn.created) so the text delta below
    // projects to a positionally-identified TEXT_MESSAGE — text deltas with no
    // active run are intentionally dropped (no crypto.randomUUID fallback).
    await hub.appendEvent("thread_fanout", SIMPLE_TEXT_TURN_ORCHESTRATOR[0]);

    hub.subscribe("thread_fanout", () => {
      throw new Error("socket send failed");
    });
    hub.subscribe("thread_fanout", received);

    await expect(hub.appendEvent("thread_fanout", SIMPLE_TEXT_TURN_ORCHESTRATOR[1])).resolves.toBe(
      1n,
    );

    expect(received).toHaveBeenCalled();
    expect(eventSink.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          source: "threads.event-hub",
          name: "listener.failed",
          payload: expect.objectContaining({ message: "socket send failed" }),
        }),
      ]),
    );
  });
});
