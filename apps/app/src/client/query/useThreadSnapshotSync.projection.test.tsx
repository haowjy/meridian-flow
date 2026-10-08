// @vitest-environment jsdom
/** Mounted snapshot owner and run controller share one durable transcript store. */
import { type AGUIEvent, EventType, type SequencedEvent } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRunController } from "@/client/copilot/ThreadRunController";
import type { ThreadCachePort } from "@/client/stores/thread-store/thread-cache";
import { createThreadCache } from "@/client/stores/thread-store/thread-cache";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import type { ThreadTransport, ThreadTransportHandlers } from "@/core/transport";
import { threadQueryKeys } from "./thread-query-keys";
import { useThreadSnapshotSync } from "./useThreadSnapshotSync";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  actions: null as ReturnType<ReturnType<typeof createThreadStore>["getState"]> | null,
  controller: null as ThreadRunController | null,
  transport: null as ThreadTransport | null,
  accountSignal: null as AbortSignal | null,
  pendingCreation: false,
  createProjectThread: vi.fn(),
  createThread: vi.fn(),
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
vi.mock("@/client/copilot/MeridianCopilotProvider", () => ({
  useMeridianAgent: () => harness.controller,
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountEpochSignal: () => harness.accountSignal,
  useAccountId: () => "account-1",
  useOptionalAccountEpochSignal: () => harness.accountSignal,
}));
vi.mock("@/client/api/threads-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/threads-api")>()),
  getThreadSnapshot: (args: unknown) => harness.snapshotRequest(args),
  createThread: harness.createThread,
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
  const controller = new ThreadRunController({
    transport,
    actions,
    accountSignal,
    accountId: "account-1",
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = false;
  harness.actions = actions;
  harness.controller = controller;
  harness.transport = transport;
  harness.accountSignal = accountSignal;
  harness.pendingCreation = false;
  disposers.push(async () => {
    try {
      if (mounted) await act(async () => root.unmount());
    } finally {
      controller.dispose();
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
    controller,
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
      const { bus, controller, store } = scenario;
      function Probe() {
        useThreadSnapshotSync("thread-1");
        return null;
      }
      await scenario.mount(<Probe />);

      controller.resume("thread-1", { expectedTurnId: "turn-1" });
      act(() => {
        bus.emit(
          { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "turn-1" } as AGUIEvent,
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
  for (const runFirst of [false, true]) {
    it(`flushes buffered deltas before durable mutation with runFirst=${runFirst}`, async () => {
      vi.useFakeTimers();
      const scenario = mountThreadProjectionScenario();
      const { bus, controller, store } = scenario;
      if (runFirst) controller.resume("thread-1", { expectedTurnId: "turn-1" });
      function Probe() {
        useThreadSnapshotSync("thread-1");
        return null;
      }
      await scenario.mount(<Probe />);
      if (!runFirst) controller.resume("thread-1", { expectedTurnId: "turn-1" });
      act(() => {
        bus.emit(
          { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "turn-1" } as AGUIEvent,
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
      expect(store.getState().liveMeta["thread-1"]?.eventsApplied).toBe(3);
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
  }
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
      liveState: { runningTurnId: null },
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
        liveState: { runningTurnId: null },
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
      liveState: { runningTurnId: null },
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
      liveState: { runningTurnId: null },
    });
    await act(async () => {
      await vi.waitFor(() => expect(observed.current?.snapshot?.nextSeq).toBe("7000"));
    });
    expect(actions.turns("thread-1")).toHaveLength(1);
  });

  it("revalidates as a run ends, on every inbox frame, and on every status frame", async () => {
    vi.useFakeTimers();
    harness.snapshotRequest.mockReset().mockImplementation(async () => ({
      thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
      turns: [],
      nextSeq: "1000",
      actionRequired: false,
      liveState: { runningTurnId: null },
    }));
    const scenario = mountThreadProjectionScenario();
    const { bus } = scenario;
    function Probe() {
      useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(1));
    const inbox = (items: unknown[]) =>
      ({ type: EventType.CUSTOM, name: "meridian.inbox.changed", value: { items } }) as AGUIEvent;
    const settle = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    };
    act(() =>
      bus.emit(
        inbox([
          {
            id: "k",
            seq: 1,
            intent: "control",
            control: { kind: "compact" },
            provenance: { kind: "writer", actorId: "w" },
            deliveryState: "awaiting_run",
            summary: "Compact conversation",
            enqueuedAt: "2026-09-28T00:00:00.000Z",
          },
        ]),
        "1000",
      ),
    );
    await settle();
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(2);
    // Frames inside one debounce window share a single refresh.
    act(() => {
      bus.emit(inbox([]), "2000");
      bus.emit(inbox([]), "2001");
    });
    await settle();
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(3);
    act(() =>
      bus.emit(
        { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "a" } as AGUIEvent,
        "3000",
      ),
    );
    await settle();
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(4);
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
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(5);
  });

  it("settles a stopped autocompaction from the empty inbox frame its lease release sends", async () => {
    // A cancelled autocompaction has no writer control and projects no
    // RUN_FINISHED; the lease release's inbox frame is its only signal.
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
    harness.snapshotRequest
      .mockReset()
      .mockResolvedValueOnce({
        thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
        turns: [compaction("pending")],
        nextSeq: "1000",
        actionRequired: false,
        liveState: { runningTurnId: null },
      })
      .mockResolvedValue({
        thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
        turns: [compaction("cancelled")],
        nextSeq: "2000",
        actionRequired: false,
        liveState: { runningTurnId: null },
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
          name: "meridian.inbox.changed",
          value: { items: [] },
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
        { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "turn-1" } as AGUIEvent,
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
      liveState: { runningTurnId: null },
    });
    await act(async () => {
      await gate.promise;
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getState().durableBlockCursorByThread["thread-1"]).toBeUndefined();
    expect(store.getState().turns("thread-1")).toBeUndefined();
    expect(client.getQueryData(threadQueryKeys.snapshot("thread-1"))).toBeUndefined();
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(1);
  });
});
