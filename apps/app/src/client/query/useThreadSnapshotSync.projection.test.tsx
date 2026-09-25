// @vitest-environment jsdom
/** Mounted snapshot owner and run controller share one durable transcript store. */
import {
  type AGUIEvent,
  EventType,
  type SequencedEvent,
  type Thread,
} from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRunController } from "@/client/copilot/ThreadRunController";
import type { ThreadCachePort } from "@/client/stores/thread-store/thread-cache";
import { createThreadCache } from "@/client/stores/thread-store/thread-cache";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import type { ThreadTransport, ThreadTransportHandlers } from "@/core/transport";
import { FakeThreadSocket } from "@/core/transport/test-support/FakeThreadSocket";
import { WsThreadTransport } from "@/core/transport/WsThreadTransport";
import { useThreadHandoff } from "@/features/chat/useThreadHandoff";
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
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

describe("first-send projection activation", () => {
  for (const createProject of [false, true]) {
    it(`installs before synchronous catch-up for createProject=${createProject}`, async () => {
      vi.useFakeTimers();
      const gate = deferred<Thread>();
      const account = new AbortController();
      harness.accountSignal = account.signal;
      harness.pendingCreation = true;
      harness.trace = [];
      harness.createProjectThread.mockReset();
      harness.createThread.mockReset();
      harness.createProject.mockReset();
      harness.getProject.mockReset();
      harness.createProjectThread.mockImplementation(() => gate.promise);
      harness.createThread.mockImplementation(() => gate.promise);
      harness.createProject.mockResolvedValue({ id: "project-1" });
      harness.getProject.mockResolvedValue({ id: "project-1", userId: "account-1" });
      if (createProject) harness.createProject.mockRejectedValueOnce(new Error("already created"));
      const store = createThreadStore({
        now: 0,
        threadCache: {
          upsertThread() {},
          patchThread() {},
          invalidateThread() {},
          invalidateThreadSnapshot() {},
        },
      });
      const actions = store.getState();
      actions.markPendingCreation({ threadId: "thread-1" });
      actions.markHandoffPending("thread-1");
      const optimistic = actions.appendUserTurn("thread-1", "write");
      actions.markPendingStream("thread-1", {
        creation: {
          projectId: "project-1",
          title: "write",
          text: "write",
          submissionId: "sub-1",
          agentSelection: { catalogEntryId: "entry", definitionRevisionId: "rev" },
          optimisticUserTurnId: optimistic.id,
          createProject,
        },
      });
      harness.actions = actions;
      const subscriptions: Array<{ handlers: ThreadTransportHandlers; active: boolean }> = [];
      const transport = {
        subscribe(_threadId: string, handlers: ThreadTransportHandlers) {
          const entry = { handlers, active: true };
          subscriptions.push(entry);
          if (!handlers.onError) harness.trace.push("durable-handler-registered");
          else {
            harness.trace.push("run-handler-registered");
            const emit = (event: AGUIEvent, seq: string) => {
              for (const listener of [...subscriptions])
                if (listener.active) listener.handlers.onEvent({ event, seq });
            };
            emit(
              { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "turn-1" } as AGUIEvent,
              "1000",
            );
            emit(card("running"), "2000");
            emit(
              { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "turn-1" } as AGUIEvent,
              "3000",
            );
          }
          return () => {
            entry.active = false;
          };
        },
        onInterruptResponseError: () => () => undefined,
        onSocketGenerationClosed: () => () => undefined,
        cancel: async () => ({ threadId: "thread-1", turnId: "turn-1", status: "cancelled" }),
      } as unknown as ThreadTransport;
      harness.transport = transport;
      const controller = new ThreadRunController({
        transport,
        actions,
        accountSignal: account.signal,
        accountId: "account-1",
        appendUserMessageFn: async () => {
          harness.trace.push("submit-called");
          return {
            threadId: "thread-1",
            submissionId: "sub-1",
            userTurnId: "user-1",
            assistantTurnId: "turn-1",
            resumeAfterSeq: "0",
            snapshotFloorNextSeq: "1",
          } as never;
        },
      });
      harness.controller = controller;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let mounted = false;
      disposers.push(async () => {
        try {
          if (mounted) await act(async () => root.unmount());
        } finally {
          controller.dispose();
          client.clear();
          host.remove();
        }
      });
      function Probe() {
        const snapshot = useThreadSnapshotSync("thread-1");
        useThreadHandoff("thread-1", "project-1", "account-1", controller, actions, {
          liveState: snapshot.liveState,
          nextSeq: snapshot.nextSeq,
          activateProjection: snapshot.activateProjection,
        });
        return null;
      }
      mounted = true;
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <Probe />
          </QueryClientProvider>,
        );
      });
      expect(subscriptions).toHaveLength(0);
      harness.trace.push("create-success");
      gate.resolve({
        id: "thread-1",
        projectId: "project-1",
        userId: "account-1",
        workId: null,
      } as Thread);
      await act(async () => {
        await vi.waitFor(() => expect(harness.trace).toContain("run-handler-registered"));
      });
      await vi.advanceTimersByTimeAsync(260);
      expect(harness.trace.slice(0, 4)).toEqual([
        "create-success",
        "submit-called",
        "durable-handler-registered",
        "run-handler-registered",
      ]);
      expect(
        store
          .getState()
          .turns("thread-1")
          ?.find((turn) => turn.id === "turn-1")?.blocks[0]?.id,
      ).toBe("card-1");
      expect(subscriptions.filter((entry) => entry.active)).toHaveLength(1);
      harness.pendingCreation = false;
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <Probe />
          </QueryClientProvider>,
        );
      });
      expect(subscriptions.filter((entry) => entry.active)).toHaveLength(1);
    });
  }
});

describe("real transport cursor rewind", () => {
  it("cannot regress a terminal card through the shared registry after run resume", async () => {
    const socket = new FakeThreadSocket();
    const transport = new WsThreadTransport({
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const scenario = mountThreadProjectionScenario({
      transport,
      disposeTransport: () => transport.disconnect(),
    });
    const { actions, controller, store } = scenario;
    actions.ensureAssistantTurn("thread-1", "turn-1");
    actions.patchTurnStatus("thread-1", "turn-1", "complete");
    function Probe() {
      useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    socket.open();
    socket.deliver({
      type: "connected",
      userId: "account-1",
      scope: { type: "standalone" },
      serverVersion: "0.0.0",
      connectionToken: "token-1",
    });
    const deliver = (event: AGUIEvent, seq: string) =>
      socket.deliver({ type: "event", threadId: "thread-1", seq, event });
    act(() => deliver(card("completed"), "4000"));
    expect(actions.turns("thread-1")?.[0]?.blocks[0]?.content).toMatchObject({
      props: { status: "completed" },
    });
    const replayed: string[] = [];
    const stopObserver = transport.subscribe("thread-1", {
      onEvent: ({ seq }) => replayed.push(seq),
    });
    controller.resume("thread-1", { after: "1000", expectedTurnId: "another-run" });
    expect(socket.sent.some((frame) => frame.includes('"lastSeq":"1000"'))).toBe(true);
    act(() => deliver(card("running"), "2000"));
    expect(replayed).toContain("2000");
    stopObserver();
    expect(actions.turns("thread-1")?.[0]?.blocks[0]?.content).toMatchObject({
      props: { status: "completed" },
    });
    expect(store.getState().durableBlockCursorByThread["thread-1"]).toBe("4000");
    const before = actions.turns("thread-1")?.[0];
    act(() => deliver(card("completed"), "5000"));
    expect(actions.turns("thread-1")?.[0]).toBe(before);
    expect(store.getState().durableBlockCursorByThread["thread-1"]).toBe("5000");
  });
});

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

  it("does not continue stale-success retries after the mounted owner is disposed", async () => {
    vi.useFakeTimers();
    const response = deferred<unknown>();
    harness.snapshotRequest.mockReset().mockImplementation(() => response.promise);
    const scenario = mountThreadProjectionScenario();
    const { actions, client, controller } = scenario;
    actions.acceptDurableBlockSeq("thread-1", "4000");
    function Probe() {
      useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    await vi.waitFor(() => expect(harness.snapshotRequest).toHaveBeenCalledTimes(1));
    await scenario.unmount();
    controller.dispose();
    expect(client.getQueryState(threadQueryKeys.snapshot("thread-1"))).toBeDefined();
    response.resolve({
      thread: { id: "thread-1", projectId: "project-1", userId: "account-1" },
      turns: [],
      nextSeq: "4000",
      actionRequired: false,
      liveState: { runningTurnId: null },
    });
    await act(async () => response.promise);
    await vi.advanceTimersByTimeAsync(800);
    expect(harness.snapshotRequest).toHaveBeenCalledTimes(1);
  });

  it("invalidates a missing addressed target without making a streaming turn", async () => {
    let invalidations = 0;
    const scenario = mountThreadProjectionScenario({
      threadCache: {
        upsertThread() {},
        patchThread() {},
        invalidateThread() {},
        invalidateThreadSnapshot() {
          invalidations++;
        },
      },
    });
    const { actions, bus, store } = scenario;
    function Probe() {
      useThreadSnapshotSync("thread-1");
      return null;
    }
    await scenario.mount(<Probe />);
    act(() => bus.emit(card("completed"), "4000"));
    expect(invalidations).toBe(1);
    expect(actions.turns("thread-1")).toBeUndefined();
    expect(store.getState().durableBlockCursorByThread["thread-1"]).toBe("4000");
    act(() => bus.emit(card("completed"), "4000"));
    expect(invalidations).toBe(1);
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
