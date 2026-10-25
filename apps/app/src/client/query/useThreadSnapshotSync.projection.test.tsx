// @vitest-environment jsdom
/** The mounted snapshot owner is the chat's one subscriber: durable blocks, the stream and run-state records.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - React snapshot callback lifetime fence
 */
import {
  type AGUIEvent,
  EventType,
  type SequencedEvent,
  type Turn,
} from "@meridian/contracts/protocol";
import type { ThreadTransport, ThreadTransportHandlers } from "@meridian/thread-client";
import { EMPTY_SYNCED_THREAD } from "@meridian/thread-client/sync";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deserializeThreadSnapshot } from "@/client/api/threads-api";
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

/** A read as the server sends it. Reads taken before a chat's frames join it at `nextSeq`. */
function readResponse(turns: unknown, nextSeq: string, threadId = "thread-1") {
  return {
    thread: { id: threadId, projectId: "project-1", userId: "account-1" },
    turns,
    nextSeq,
    actionRequired: false,
    liveState: { runningTurnId: null, resumeAfterSeq: nextSeq, runState: IDLE_RUN_STATE },
  };
}

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

/** A completed assistant turn already in the chat's cell, as an earlier mount would leave it. */
function seedCompleteTurn(store: ReturnType<typeof createThreadStore>, threadId: string) {
  const turn = { id: "turn-1", threadId, role: "assistant", status: "complete", blocks: [] };
  store.setState((state) => ({
    syncedByThread: {
      ...state.syncedByThread,
      [threadId]: { ...EMPTY_SYNCED_THREAD, turns: [turn as unknown as Turn] },
    },
  }));
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

describe("stale acquisition and missing targets", () => {
  it("rejects an old terminal snapshot before Query cache or handoff and retries", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    const fourth = deferred<unknown>();
    harness.snapshotRequest
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise)
      .mockImplementationOnce(() => fourth.promise);
    const scenario = mountThreadProjectionScenario();
    const { actions, bus, client } = scenario;
    seedCompleteTurn(scenario.store, "thread-1");
    const observed = { current: null as ReturnType<typeof useThreadSnapshotSync> | null };
    function Probe() {
      observed.current = useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    // Read first: the join read opens the stream; the cards then raise the floor past what it held.
    first.resolve(readResponse(structuredClone(actions.turns("thread-1")), "1000"));
    await act(async () => {
      await vi.waitFor(() => expect(bus.subscriptions).toHaveLength(1));
    });
    act(() => bus.emit(card("running"), "3000"));
    const staleTurns = structuredClone(actions.turns("thread-1"));
    act(() => bus.emit(card("completed"), "4000"));
    const currentTurns = structuredClone(actions.turns("thread-1"));
    const response = readResponse;
    act(() => observed.current?.refetch());
    await act(async () => {
      await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(2));
    });
    second.resolve(response(staleTurns, "4000"));
    await act(async () => {
      await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(3));
    });
    // The old terminal read never replaced the join read in Query's cache.
    expect(client.getQueryData(threadQueryKeys.snapshot("thread-1"))).toMatchObject({
      nextSeq: "1000",
    });
    expect(observed.current?.snapshot).toBeNull();
    expect(actions.turns("thread-1")?.[0]?.blocks[0]?.content).toMatchObject({
      props: { status: "completed" },
    });
    third.resolve(response(staleTurns, "4000"));
    await act(async () => {
      await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(4));
    });
    expect(observed.current?.snapshot).toBeNull();
    expect(observed.current?.isError).toBe(false);
    fourth.resolve(response(currentTurns, "5000"));
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

    // The cache's read is offered on every mount and the sync decides: a cell holding nothing newer
    // joins on it; a cell whose last generation wrote past it waits for the mount fetch.
    harness.snapshotRequest.mockReset().mockImplementation(() => new Promise(() => undefined));
    for (const [cursor, joins] of [
      ["1000", true],
      ["5000", false],
    ] as const) {
      const kept = mountThreadProjectionScenario();
      kept.store.setState((state) => ({
        syncedByThread: {
          ...state.syncedByThread,
          "thread-1": { ...EMPTY_SYNCED_THREAD, deliveryCursor: cursor },
        },
      }));
      kept.client.setQueryData(
        threadQueryKeys.snapshot("thread-1"),
        deserializeThreadSnapshot(readResponse([], "3000") as never),
      );
      function Kept() {
        useThreadSnapshotSync("thread-1");
        return null;
      }
      await kept.mount(<Kept />);
      expect(kept.bus.subscriptions.filter((entry) => entry.active)).toHaveLength(joins ? 1 : 0);
      await kept.unmount();
    }
  });
});

describe("projection lifetime fencing", () => {
  it("invalidates saved callbacks across StrictMode replay, thread switch, and unmount", async () => {
    // Each chat's first read joins its stream: nothing is subscribed before it applies.
    harness.snapshotRequest.mockReset().mockImplementation((args) => {
      const { threadId } = (args as { data: { threadId: string } }).data;
      // The departed chat's own reads (below) never complete.
      if (threadId === "thread-3") return new Promise(() => undefined);
      return Promise.resolve(
        readResponse(
          [{ id: "turn-1", threadId, role: "assistant", status: "complete", blocks: [] }],
          "1000",
          threadId,
        ),
      );
    });
    const scenario = mountThreadProjectionScenario();
    const { actions, bus } = scenario;
    for (const threadId of ["thread-1", "thread-2"]) {
      seedCompleteTurn(scenario.store, threadId);
    }
    const render = async (threadId: string) => {
      await scenario.render(<Probe threadId={threadId} />, true);
      await act(async () => {
        await vi.waitFor(() => expect(bus.subscriptions.some((entry) => entry.active)).toBe(true));
      });
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

    // A fresh read asked for at the moment the chat unmounts is a departed chat's: it starts no
    // request and writes nothing.
    const departing = mountThreadProjectionScenario();
    departing.client.setQueryData(
      threadQueryKeys.snapshot("thread-3"),
      deserializeThreadSnapshot(readResponse([], "0", "thread-3") as never),
    );
    await departing.mount(<Probe threadId="thread-3" />);
    expect(departing.bus.subscriptions.filter((entry) => entry.active)).toHaveLength(1);
    const requests = harness.snapshotRequest.mock.calls.length;
    departing.bus.emit(
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-3",
        runId: "turn-9",
        rawEvent: { writeMode: null },
      } as AGUIEvent,
      "1000",
    );
    departing.bus.emit(
      { type: EventType.RUN_FINISHED, threadId: "thread-3", runId: "turn-9" } as AGUIEvent,
      "2000",
    );
    await departing.unmount();
    const written = departing.store.getState().syncedByThread["thread-3"];
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.snapshotRequest.mock.calls.length).toBe(requests);
    expect(departing.store.getState().syncedByThread["thread-3"]).toBe(written);
  });

  it("ignores buffered events, timers, and HTTP completion after account abort before unmount", async () => {
    vi.useFakeTimers();
    const join = deferred<unknown>();
    const later = deferred<unknown>();
    harness.snapshotRequest
      .mockReset()
      .mockImplementationOnce(() => join.promise)
      .mockImplementation(() => later.promise);
    const account = new AbortController();
    const scenario = mountThreadProjectionScenario({ accountSignal: account.signal });
    const { bus, client, store } = scenario;
    function Probe() {
      useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    // The join read opens the stream; the account then aborts with a read still in flight.
    join.resolve(readResponse([], "0"));
    await act(async () => {
      await vi.waitFor(() => expect(bus.subscriptions).toHaveLength(1));
    });
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
    later.resolve(readResponse([], "3000"));
    await act(async () => {
      await later.promise;
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
    // Only the join read, taken before the abort, is cached.
    expect(client.getQueryData(threadQueryKeys.snapshot("thread-1"))).toMatchObject({
      nextSeq: "0",
    });
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(1);
  });
});
