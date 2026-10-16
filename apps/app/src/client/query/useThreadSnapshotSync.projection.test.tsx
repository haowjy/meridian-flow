// @vitest-environment jsdom
/** The mounted snapshot owner is the chat's one subscriber: durable blocks, the stream and run-state records. */
import { type AGUIEvent, EventType, type SequencedEvent } from "@meridian/contracts/protocol";
import type { ThreadTransport, ThreadTransportHandlers } from "@meridian/thread-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadCachePort } from "@/client/stores/thread-store/thread-cache";
import { createThreadCache } from "@/client/stores/thread-store/thread-cache";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import { threadQueryKeys } from "./thread-query-keys";
import { useThreadSnapshotSync } from "./useThreadSnapshotSync";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  actions: null as ReturnType<ReturnType<typeof createThreadStore>["getState"]> | null,
  transport: null as ThreadTransport | null,
  accountSignal: null as AbortSignal | null,
  pendingCreation: false,
  createProjectThread: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  trace: [] as string[],
  snapshotRequest: vi.fn((_args?: unknown) => new Promise(() => undefined)),
}));
vi.mock("@/core/transport/dev-transport", () => ({
  buildThreadsWsUrl: () => "ws://test/api/threads/ws",
}));
vi.mock("@/client/stores", () => ({
  useThreadActions: () => harness.actions,
  useIsThreadPendingCreation: () => harness.pendingCreation,
}));
vi.mock("@/client/providers/TransportProvider", () => ({
  useThreadTransport: () => harness.transport,
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountEpochSignal: () => harness.accountSignal,
  useAccountId: () => "account-1",
  useOptionalAccountEpochSignal: () => harness.accountSignal,
}));
vi.mock("@/client/api/threads-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/threads-api")>()),
  getThreadSnapshot: (args: unknown) => harness.snapshotRequest(args),
}));

vi.mock("@/client/api/projects-api", () => ({
  createProjectThread: harness.createProjectThread,
  createProject: harness.createProject,
  getProject: harness.getProject,
}));
vi.mock("@/client/query/project-invalidation", () => ({
  invalidateProjectThreadData: async () => undefined,
  invalidateWorkThreads: async () => undefined,
}));

const IDLE_RUN_STATE = {
  version: "0",
  items: [],
  sentThrough: 0,
  execution: null,
  mode: "direct",
  blocked: null,
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Explicit-order listener bus; socket routing and replay are covered by FakeThreadSocket. */
function controlledListenerBus() {
  const subscriptions: Array<{ handlers: ThreadTransportHandlers; active: boolean }> = [];
  const transport = {
    subscribe(_threadId: string, handlers: ThreadTransportHandlers) {
      const entry = { handlers, active: true };
      subscriptions.push(entry);
      return () => {
        entry.active = false;
      };
    },
    onInterruptResponseError: () => () => undefined,
    onSocketGenerationClosed: () => () => undefined,
    cancel: async () => ({ threadId: "thread-1", turnId: "turn-1", status: "cancelled" }),
  } as unknown as ThreadTransport;
  const emit = (event: AGUIEvent, seq: string) => {
    for (const entry of [...subscriptions]) {
      if (entry.active) entry.handlers.onEvent({ seq, event } as SequencedEvent);
    }
  };
  return { transport, subscriptions, emit };
}

function mountThreadProjectionScenario(
  options: {
    transport?: ThreadTransport;
    disposeTransport?: () => void;
    accountSignal?: AbortSignal;
    threadCache?: ThreadCachePort;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createThreadStore({
    now: 0,
    threadCache: options.threadCache ?? createThreadCache(client),
  });
  const actions = store.getState();
  const bus = controlledListenerBus();
  const transport = options.transport ?? bus.transport;
  const accountSignal = options.accountSignal ?? new AbortController().signal;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = false;
  harness.actions = actions;
  harness.transport = transport;
  harness.accountSignal = accountSignal;
  harness.pendingCreation = false;
  disposers.push(async () => {
    try {
      if (mounted) await act(async () => root.unmount());
    } finally {
      options.disposeTransport?.();
      client.clear();
      host.remove();
    }
  });
  const render = async (element: ReactNode, strict = false) => {
    mounted = true;
    await act(async () =>
      root.render(
        strict ? (
          <StrictMode>
            <QueryClientProvider client={client}>{element}</QueryClientProvider>
          </StrictMode>
        ) : (
          <QueryClientProvider client={client}>{element}</QueryClientProvider>
        ),
      ),
    );
  };
  return {
    actions,
    bus,
    client,
    mount: render,
    render,
    unmount: async () => {
      if (!mounted) return;
      await act(async () => root.unmount());
      mounted = false;
    },
    store,
  };
}

function card(status: string): AGUIEvent {
  return {
    type: EventType.CUSTOM,
    name: "meridian.block.upserted",
    value: {
      block: {
        id: "card-1",
        turnId: "turn-1",
        blockType: "custom",
        sequence: 4,
        content: {
          kind: "spawn",
          props: { status, toolCallId: "call-1", execution: "child-turn" },
        },
      },
    },
  } as AGUIEvent;
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of disposers.splice(0)) await dispose();
  } finally {
    vi.useRealTimers();
    harness.snapshotRequest.mockReset().mockImplementation(() => new Promise(() => undefined));
  }
});

for (const terminal of [EventType.RUN_FINISHED, EventType.RUN_ERROR]) {
  describe(`durable owner after ${terminal}`, () => {
    it("replaces the original historical card with snapshots withheld and no new run", async () => {
      vi.useFakeTimers();
      const scenario = mountThreadProjectionScenario();
      const { bus, store } = scenario;
      function Probe() {
        useThreadSnapshotSync("thread-1");
        return null;
      }
      await scenario.mount(<Probe />);

      act(() => {
        bus.emit(
          {
            type: EventType.RUN_STARTED,
            threadId: "thread-1",
            runId: "turn-1",
            rawEvent: { writeMode: null },
          } as AGUIEvent,
          "1000",
        );
        bus.emit(card("running"), "2000");
        bus.emit({ type: terminal, threadId: "thread-1", runId: "turn-1" } as AGUIEvent, "3000");
      });
      await vi.advanceTimersByTimeAsync(260);
      expect(bus.subscriptions.filter((entry) => entry.active)).toHaveLength(1);
      const before = store.getState().turns("thread-1")?.[0];
      expect(before?.blocks[0]?.id).toBe("card-1");
      act(() => {
        bus.emit(card("completed"), "4000");
      });
      const after = store.getState().turns("thread-1")?.[0];
      expect(after?.blocks[0]?.content).toMatchObject({
        props: { status: "completed", toolCallId: "call-1", execution: "child-turn" },
      });
      expect(after?.status).not.toBe("streaming");
      expect(after?.blocks[0]?.id).toBe(before?.blocks[0]?.id);
      expect(after?.blocks[0]?.sequence).toBe(before?.blocks[0]?.sequence);
    });
  });
}

describe("current stream ordering", () => {
  it("flushes buffered deltas before durable mutation", async () => {
    vi.useFakeTimers();
    const scenario = mountThreadProjectionScenario();
    const { bus, store } = scenario;
    function Probe() {
      useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    act(() => {
      bus.emit(
        {
          type: EventType.RUN_STARTED,
          threadId: "thread-1",
          runId: "turn-1",
          rawEvent: { writeMode: null },
        } as AGUIEvent,
        "1000",
      );
      bus.emit({ type: EventType.TEXT_MESSAGE_START, messageId: "text-1" } as AGUIEvent, "1100");
      bus.emit(
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "text-1",
          delta: "hello",
        } as AGUIEvent,
        "1200",
      );
      bus.emit(card("running"), "1300");
    });
    const blocks = store
      .getState()
      .turns("thread-1")
      ?.find((turn) => turn.id === "turn-1")?.blocks;
    expect(blocks?.find((block) => block.id === "text-1")?.textContent).toBe("hello");
    expect(blocks?.find((block) => block.id === "card-1")?.content).toMatchObject({
      props: { status: "running" },
    });
    expect(store.getState().syncedByThread["thread-1"]?.eventsApplied).toBe(3);
    act(() => {
      bus.emit(
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "text-1",
          delta: " world",
        } as AGUIEvent,
        "1400",
      );
      bus.emit(
        { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "turn-1" } as AGUIEvent,
        "1500",
      );
    });
    await vi.advanceTimersByTimeAsync(260);
    expect(
      store
        .getState()
        .turns("thread-1")
        ?.find((turn) => turn.id === "turn-1")
        ?.blocks.find((block) => block.id === "text-1")?.textContent,
    ).toBe("hello world");
    expect(bus.subscriptions.filter((entry) => entry.active)).toHaveLength(1);
  });
});

describe("stale acquisition and missing targets", () => {
  it("rejects an old terminal snapshot before Query cache or handoff and retries", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    harness.snapshotRequest
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    const scenario = mountThreadProjectionScenario();
    const { actions, bus, client } = scenario;
    actions.ensureAssistantTurn("thread-1", "turn-1");
    actions.patchTurnStatus("thread-1", "turn-1", "complete");
    const observed = { current: null as ReturnType<typeof useThreadSnapshotSync> | null };
    function Probe() {
      observed.current = useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    act(() => bus.emit(card("running"), "3000"));
    const staleTurns = structuredClone(actions.turns("thread-1"));
    act(() => bus.emit(card("completed"), "4000"));
    const currentTurns = structuredClone(actions.turns("thread-1"));
    const response = (turns: unknown, nextSeq: string) => ({
      thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
      turns,
      nextSeq,
      actionRequired: false,
      liveState: { runningTurnId: null, runState: IDLE_RUN_STATE },
    });
    first.resolve(response(staleTurns, "4000"));
    await act(async () => {
      await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(2));
    });
    expect(client.getQueryData(threadQueryKeys.snapshot("thread-1"))).toBeUndefined();
    expect(observed.current?.snapshot).toBeNull();
    expect(actions.turns("thread-1")?.[0]?.blocks[0]?.content).toMatchObject({
      props: { status: "completed" },
    });
    second.resolve(response(staleTurns, "4000"));
    await act(async () => {
      await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(3));
    });
    expect(observed.current?.snapshot).toBeNull();
    expect(observed.current?.isError).toBe(false);
    expect(observed.current?.settled).toBe(false);
    third.resolve(response(currentTurns, "5000"));
    await act(async () => {
      await vi.waitFor(() => expect(observed.current?.snapshot?.nextSeq).toBe("5000"));
    });
    expect(actions.turns("thread-1")?.[0]?.blocks[0]?.content).toMatchObject({
      props: { status: "completed" },
    });
  });

  it("coalesces distinct missing-target frames against a populated real query cache", async () => {
    const held = deferred<unknown>();
    const recovered = deferred<unknown>();
    harness.snapshotRequest
      .mockReset()
      .mockResolvedValueOnce({
        thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
        turns: [],
        nextSeq: "1000",
        actionRequired: false,
        liveState: { runningTurnId: null, runState: IDLE_RUN_STATE },
      })
      .mockImplementationOnce(() => held.promise)
      .mockImplementationOnce(() => recovered.promise);
    const scenario = mountThreadProjectionScenario();
    const { actions, bus } = scenario;
    const observed = { current: null as ReturnType<typeof useThreadSnapshotSync> | null };
    function Probe() {
      observed.current = useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    await act(async () => {
      await vi.waitFor(() => expect(observed.current?.snapshot?.nextSeq).toBe("1000"));
    });
    act(() => {
      bus.emit(card("running"), "4000");
      bus.emit(card("running"), "5000");
      bus.emit(card("completed"), "6000");
    });
    await act(async () => {
      await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(2));
    });
    expect(actions.turns("thread-1")).toEqual([]);
    held.resolve({
      thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
      turns: [],
      nextSeq: "4000",
      actionRequired: false,
      liveState: { runningTurnId: null, runState: IDLE_RUN_STATE },
    });
    await act(async () => {
      await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(3));
    });
    recovered.resolve({
      thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
      turns: [
        { id: "turn-1", threadId: "thread-1", role: "assistant", status: "complete", blocks: [] },
      ],
      nextSeq: "7000",
      actionRequired: false,
      liveState: { runningTurnId: null, runState: IDLE_RUN_STATE },
    });
    await act(async () => {
      await vi.waitFor(() => expect(observed.current?.snapshot?.nextSeq).toBe("7000"));
    });
    expect(actions.turns("thread-1")).toHaveLength(1);
  });

  it("revalidates as a run ends, on a record whose execution changed, and on every status frame", async () => {
    vi.useFakeTimers();
    harness.snapshotRequest.mockReset().mockImplementation(async () => ({
      thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
      turns: [],
      nextSeq: "1000",
      actionRequired: false,
      liveState: { runningTurnId: null, runState: IDLE_RUN_STATE },
    }));
    const scenario = mountThreadProjectionScenario();
    const { bus } = scenario;
    function Probe() {
      useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(1));
    const record = (version: string, executionId: string | null) =>
      ({
        type: EventType.CUSTOM,
        name: "meridian.run_state",
        value: {
          ...IDLE_RUN_STATE,
          version,
          execution: executionId ? { executionId, currentTurnId: null } : null,
        },
      }) as AGUIEvent;
    const settle = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    };
    // A divider reserves: the record's execution changed.
    act(() => bus.emit(record("1000", "e1"), "1000"));
    await settle();
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(2);
    // The same execution, and an older record, change nothing.
    act(() => {
      bus.emit(record("1500", "e1"), "1500");
      bus.emit(record("900", null), "1501");
    });
    await settle();
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(2);
    // Frames inside one debounce window share a single refresh.
    act(() => {
      bus.emit(record("2000", null), "2000");
      bus.emit(record("2001", "e2"), "2001");
    });
    await settle();
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(3);
    // A record naming another client's waiting message revalidates once: the stream does not
    // carry that user turn.
    const waiting = (version: string, id: string) =>
      ({
        type: EventType.CUSTOM,
        name: "meridian.run_state",
        value: {
          ...IDLE_RUN_STATE,
          version,
          execution: { executionId: "e2", currentTurnId: null },
          items: [
            {
              id,
              intent: "message",
              seq: 1,
              provenance: { kind: "writer", actorId: "u1" },
              deliveryState: "waiting",
              summary: "M2",
              enqueuedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      }) as AGUIEvent;
    act(() => {
      bus.emit(waiting("2500", "foreign-1"), "2500");
      bus.emit(waiting("2501", "foreign-1"), "2501");
    });
    await settle();
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(4);
    // The run's end revalidates too (the store's own terminal refresh may add one more).
    act(() =>
      bus.emit(
        { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "a" } as AGUIEvent,
        "3000",
      ),
    );
    await settle();
    const afterRun = harness.snapshotRequest.mock.calls.length;
    expect(afterRun).toBeGreaterThan(4);
    // A handoff brief starts and ends with no run: only its status frame says so.
    act(() =>
      bus.emit(
        {
          type: EventType.CUSTOM,
          name: "meridian.thread.status",
          value: { threadId: "thread-1", status: { kind: "asleep" }, runningTurnId: null },
        } as AGUIEvent,
        "4000",
      ),
    );
    await settle();
    expect(harness.snapshotRequest.mock.calls.length).toBeGreaterThan(afterRun);
  });

  it("settles a stopped autocompaction from the record its lease release sends", async () => {
    // A cancelled autocompaction projects no RUN_FINISHED; the record whose execution closed
    // is its only signal.
    vi.useFakeTimers();
    const compaction = (status: "pending" | "cancelled") => ({
      id: "c",
      threadId: "thread-1",
      role: "compaction",
      status,
      position: 3,
      blocks: [],
      metadata: { kind: "compaction", trigger: "auto" },
    });
    const running = {
      ...IDLE_RUN_STATE,
      version: "1000",
      execution: { executionId: "e-c", currentTurnId: "c" },
    };
    harness.snapshotRequest
      .mockReset()
      .mockResolvedValueOnce({
        thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
        turns: [compaction("pending")],
        nextSeq: "1000",
        actionRequired: false,
        liveState: { runningTurnId: null, runState: running },
      })
      .mockResolvedValue({
        thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
        turns: [compaction("cancelled")],
        nextSeq: "2000",
        actionRequired: false,
        liveState: { runningTurnId: null, runState: { ...IDLE_RUN_STATE, version: "2000" } },
      });
    const scenario = mountThreadProjectionScenario();
    const { bus } = scenario;
    let status: string | null = null;
    function Probe() {
      status = useThreadSnapshotSync("thread-1").snapshot?.turns[0]?.status ?? null;
      return null;
    }
    await scenario.mount(<Probe />);
    await vi.waitFor(() => expect(status).toBe("pending"));
    act(() =>
      bus.emit(
        {
          type: EventType.CUSTOM,
          name: "meridian.run_state",
          value: { ...IDLE_RUN_STATE, version: "2000" },
        } as AGUIEvent,
        "2000",
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(status).toBe("cancelled"));
  });

  it("reports history settled only once its turns are in the transcript store", async () => {
    // A reveal into a chat the page has not loaded asks "is this turn absent?"
    // the moment history settles. Settling before the turns reach the store
    // reads as an empty chat, and the reveal gives up on a turn about to arrive.
    // An error settles the history for that reader even though nothing loaded.
    const held = deferred<unknown>();
    harness.snapshotRequest
      .mockReset()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() => held.promise);
    const scenario = mountThreadProjectionScenario();
    const { actions } = scenario;
    const renders: Array<{ settled: boolean; turns: number }> = [];
    let refetch: () => void = () => undefined;
    function Probe() {
      const sync = useThreadSnapshotSync("thread-1");
      refetch = sync.refetch;
      renders.push({
        settled: sync.settled,
        turns: actions.turns("thread-1")?.length ?? 0,
      });
      return null;
    }
    await scenario.mount(<Probe />);
    await act(async () => {
      await vi.waitFor(() => expect(renders.at(-1)?.settled).toBe(true));
    });
    expect(renders.at(-1)).toEqual({ settled: true, turns: 0 });
    const erroredRenders = renders.length;
    await act(async () => refetch());
    held.resolve({
      thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
      turns: [
        {
          id: "t1",
          threadId: "thread-1",
          role: "user",
          status: "complete",
          position: 1,
          blocks: [],
        },
        {
          id: "t2",
          threadId: "thread-1",
          role: "user",
          status: "complete",
          position: 2,
          blocks: [],
        },
      ],
      nextSeq: "1000",
      actionRequired: false,
      liveState: { runningTurnId: null, runState: IDLE_RUN_STATE },
    });
    await act(async () => {
      await vi.waitFor(() => expect(renders.at(-1)?.turns).toBe(2));
    });
    expect(renders.at(-1)).toEqual({ settled: true, turns: 2 });
    expect(renders.slice(erroredRenders).filter((r) => r.settled && r.turns === 0)).toEqual([]);
  });
});

describe("projection lifetime fencing", () => {
  it("invalidates saved callbacks across StrictMode replay, thread switch, and unmount", async () => {
    const scenario = mountThreadProjectionScenario();
    const { actions, bus } = scenario;
    for (const threadId of ["thread-1", "thread-2"]) {
      actions.ensureAssistantTurn(threadId, "turn-1");
      actions.patchTurnStatus(threadId, "turn-1", "complete");
    }
    const render = async (threadId: string) => {
      await scenario.render(<Probe threadId={threadId} />, true);
    };
    function Probe({ threadId }: { threadId: string }) {
      useThreadSnapshotSync(threadId);
      return null;
    }
    await render("thread-1");
    expect(bus.subscriptions.filter((entry) => entry.active)).toHaveLength(1);
    const stale = bus.subscriptions[0]?.handlers.onEvent;
    expect(stale).toBeDefined();
    await render("thread-2");
    expect(bus.subscriptions.filter((entry) => entry.active)).toHaveLength(1);
    act(() => {
      stale?.({ seq: "4000", event: card("stale"), sourceThreadId: "thread-1" });
      bus.subscriptions.at(-1)?.handlers.onEvent({
        seq: "4000",
        event: card("current"),
        sourceThreadId: "thread-2",
      });
    });
    expect(actions.turns("thread-1")?.[0]?.blocks).toHaveLength(0);
    expect(actions.turns("thread-2")?.[0]?.blocks[0]?.content).toMatchObject({
      props: { status: "current" },
    });
    await scenario.unmount();
    act(() =>
      bus.subscriptions.at(-1)?.handlers.onEvent({
        seq: "5000",
        event: card("after-unmount"),
        sourceThreadId: "thread-2",
      }),
    );
    expect(actions.turns("thread-2")?.[0]?.blocks[0]?.content).toMatchObject({
      props: { status: "current" },
    });
  });

  it("ignores buffered events, timers, and HTTP completion after account abort before unmount", async () => {
    vi.useFakeTimers();
    const gate = deferred<unknown>();
    harness.snapshotRequest.mockReset().mockImplementation(() => gate.promise);
    const account = new AbortController();
    const scenario = mountThreadProjectionScenario({ accountSignal: account.signal });
    const { bus, client, store } = scenario;
    function Probe() {
      useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    const callback = bus.subscriptions[0]?.handlers.onEvent;
    expect(callback).toBeDefined();
    act(() =>
      bus.emit(
        {
          type: EventType.RUN_STARTED,
          threadId: "thread-1",
          runId: "turn-1",
          rawEvent: { writeMode: null },
        } as AGUIEvent,
        "1000",
      ),
    );
    account.abort();
    act(() => callback?.({ seq: "2000", event: card("completed") }));
    gate.resolve({
      thread: { id: "thread-1", userId: "account-1" },
      turns: [],
      nextSeq: "3000",
      actionRequired: false,
      liveState: { runningTurnId: null, runState: IDLE_RUN_STATE },
    });
    await act(async () => {
      await gate.promise;
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getState().syncedByThread["thread-1"]?.durableCursor ?? undefined).toBeUndefined();
    // The run's start applied before the abort; the durable card after it did not.
    expect(
      store
        .getState()
        .turns("thread-1")
        ?.flatMap((turn) => turn.blocks),
    ).toEqual([]);
    expect(client.getQueryData(threadQueryKeys.snapshot("thread-1"))).toBeUndefined();
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(1);
  });
});
