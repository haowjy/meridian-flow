// @vitest-environment jsdom
/** First-send owners share one wire subscription, only after admission accepts. */
import { EventType, type SendMessageResponse, type Thread } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useStore } from "zustand";
import { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { useThreadSnapshotSync } from "@/client/query/useThreadSnapshotSync";
import { createThreadCache } from "@/client/stores/thread-store/thread-cache";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import { FakeThreadSocket } from "@/core/transport/test-support/FakeThreadSocket";
import { WsThreadTransport } from "@/core/transport/WsThreadTransport";
import { usePendingInbox } from "./usePendingInbox";
import { useThreadActivity } from "./useThreadActivity";
import { useThreadDurableProjections } from "./useThreadDurableProjections";
import { useThreadHandoff } from "./useThreadHandoff";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  actions: null as ReturnType<ReturnType<typeof createThreadStore>["getState"]> | null,
  store: null as ReturnType<typeof createThreadStore> | null,
  controller: null as ThreadRunController | null,
  transport: null as WsThreadTransport | null,
  account: new AbortController(),
  create: vi.fn(),
  snapshot: vi.fn(() => new Promise(() => undefined)),
  trails: vi.fn(async () => []),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
}));
vi.mock("@/client/stores", () => ({
  useThreadActions: () => harness.actions,
  useIsThreadPendingCreation: (id: string) =>
    useStore(
      harness.store as ReturnType<typeof createThreadStore>,
      (state) => !!state.pendingCreation.threadIds[id],
    ),
  announceError: vi.fn(),
}));
vi.mock("@/client/providers/TransportProvider", () => ({
  useThreadTransport: () => harness.transport,
}));
vi.mock("@/client/copilot/MeridianCopilotProvider", () => ({
  useMeridianAgent: () => harness.controller,
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountId: () => "account-1",
  useAccountEpochSignal: () => harness.account.signal,
  useOptionalAccountEpochSignal: () => harness.account.signal,
}));
vi.mock("@/core/transport/dev-transport", () => ({
  buildThreadsWsUrl: () => "ws://test/api/threads/ws",
}));
vi.mock("@/client/api/projects-api", () => ({ createProjectThread: harness.create }));
vi.mock("@/client/api/threads-api", async (original) => ({
  ...(await original<typeof import("@/client/api/threads-api")>()),
  getThreadSnapshot: harness.snapshot,
}));
vi.mock("@/client/change-trails", async (original) => ({
  ...(await original<typeof import("@/client/change-trails")>()),
  listChangeTrailShells: harness.trails,
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

it("waits for acceptance, subscribes once, and keeps the durable owner through settlement and reconnect", async () => {
  const created = deferred<Thread>();
  const admitted = deferred<SendMessageResponse>();
  harness.create.mockReturnValue(created.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createThreadStore({ now: 0, threadCache: createThreadCache(client) });
  const actions = store.getState();
  harness.store = store;
  harness.actions = actions;
  const firstSocket = new FakeThreadSocket();
  const nextSocket = new FakeThreadSocket();
  const sockets: FakeThreadSocket[] = [];
  const transport = new WsThreadTransport({
    webSocketFactory: () => {
      const socket = sockets.length === 0 ? firstSocket : nextSocket;
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  harness.transport = transport;
  const append = vi.fn(() => admitted.promise);
  const controller = new ThreadRunController({
    transport,
    actions,
    accountSignal: harness.account.signal,
    accountId: "account-1",
    appendUserMessageFn: append,
  });
  harness.controller = controller;
  const threadId = "thread-1";
  actions.markPendingCreation({ threadId });
  actions.markHandoffPending(threadId);
  const optimistic = actions.appendUserTurn(threadId, "write");
  actions.markPendingStream(threadId, {
    creation: {
      projectId: "project-1",
      title: "write",
      text: "write",
      optimisticUserTurnId: optimistic.id,
      agentSelection: { catalogEntryId: "entry", definitionRevisionId: "rev" },
    },
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe() {
    const snapshot = useThreadSnapshotSync(threadId);
    useThreadDurableProjections({ threadId, projectId: "project-1" });
    useThreadActivity({ threadId, rootThreadId: threadId, seed: snapshot.liveState });
    usePendingInbox({ threadId, seed: snapshot.liveState });
    useThreadHandoff(threadId, "project-1", "account-1", controller, actions, snapshot);
    return null;
  }
  const connect = (socket: FakeThreadSocket) => {
    socket.open();
    socket.deliver({
      type: "connected",
      userId: "account-1",
      scope: { type: "standalone" },
      serverVersion: "0.0.0",
      connectionToken: "token-1",
    });
  };
  transport.connect();
  connect(firstSocket);
  const frames = () => sockets.flatMap((socket) => socket.sent.map((frame) => JSON.parse(frame)));
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(frames()).toEqual([]);
    expect(harness.trails).not.toHaveBeenCalled();
    expect(harness.snapshot).not.toHaveBeenCalled();
    await act(async () =>
      created.resolve({
        id: threadId,
        projectId: "project-1",
        userId: "account-1",
        workId: null,
      } as Thread),
    );
    expect(append).toHaveBeenCalledTimes(1);
    expect(frames()).toEqual([]);
    await act(async () =>
      admitted.resolve({
        threadId,
        status: "accepted",
        userTurnId: "user-1",
        assistantTurnId: "turn-1",
        resumeAfterSeq: "1000",
        snapshotFloorNextSeq: "1001",
      }),
    );
    expect(frames()).toEqual([{ type: "subscribe", threadId, lastSeq: "1000" }]);
    const deliver = (event: unknown, seq: string) =>
      firstSocket.deliver({
        type: "event",
        threadId,
        seq,
        event,
      });
    await act(async () => {
      deliver({ type: EventType.RUN_STARTED, threadId, runId: "turn-1" }, "2000");
      deliver(
        {
          type: EventType.CUSTOM,
          name: "meridian.block.upserted",
          value: {
            block: {
              id: "text-1",
              turnId: "turn-1",
              blockType: "custom",
              sequence: 0,
              content: { kind: "spawn", props: { status: "completed" } },
            },
          },
        },
        "3000",
      );
      deliver({ type: EventType.RUN_FINISHED, threadId, runId: "turn-1" }, "4000");
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(actions.turns(threadId)?.filter((turn) => turn.id === "turn-1")).toHaveLength(1);
    expect(actions.turns(threadId)?.find((turn) => turn.id === "turn-1")?.blocks).toHaveLength(1);
    expect(frames()).toEqual([{ type: "subscribe", threadId, lastSeq: "1000" }]);
    act(() => {
      transport.reconnect();
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    act(() => connect(nextSocket));
    expect(frames().at(-1)).toEqual({
      type: "resume",
      subscriptions: [{ threadId, lastSeq: "4000" }],
    });
  } finally {
    await act(async () => root.unmount());
    controller.dispose();
    transport.disconnect();
    client.clear();
    host.remove();
  }
});
