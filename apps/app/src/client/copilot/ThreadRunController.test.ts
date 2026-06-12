// @ts-nocheck
/**
 * ThreadRunController tests — protects direct transport run orchestration.
 *
 * These cases cover the direct controller contract without AG-UI client
 * machinery: submit/resume subscription startup, stale event filtering,
 * deferred cancel, teardown, and singleton gap snapshot recovery into store
 * actions.
 */

import type { AGUIEvent, Thread, ThreadSnapshotResponse, Turn } from "@meridian/contracts/protocol";
import { EventType, type SequencedEvent } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { ThreadStoreActions } from "@/client/stores";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import type {
  ThreadTransport,
  ThreadTransportHandlers,
  ThreadTransportSubscribeOptions,
} from "@/core/transport";

import { ThreadRunController } from "./ThreadRunController";

class FakeThreadTransport implements ThreadTransport {
  handlers: ThreadTransportHandlers | null = null;
  subscribeOptions: ThreadTransportSubscribeOptions | undefined;
  subscribeThreadId: string | null = null;
  unsubscribeCount = 0;
  subscribeCount = 0;
  respondCheckpoint = vi.fn();
  cancel = vi.fn().mockResolvedValue({
    threadId: "thread_1",
    turnId: "turn_1",
    status: "cancelled",
  });

  connect(): void {}

  disconnect(): void {}

  reconnect(): void {}

  onConnectionState(): () => void {
    return () => {};
  }

  subscribe(
    threadId: string,
    handlers: ThreadTransportHandlers,
    opts?: ThreadTransportSubscribeOptions,
  ): () => void {
    this.handlers = handlers;
    this.subscribeThreadId = threadId;
    this.subscribeOptions = opts;
    this.subscribeCount += 1;
    return () => {
      if (this.handlers === handlers) {
        this.handlers = null;
      }
      this.unsubscribeCount += 1;
    };
  }

  emit(event: AGUIEvent, seq = "1", sourceThreadId?: string) {
    this.handlers?.onEvent({ seq, event, sourceThreadId } satisfies SequencedEvent);
  }
}

async function waitForCancel(transport: FakeThreadTransport): Promise<void> {
  await transport.cancel.mock.results.at(-1)?.value;
}

function makeActions(): ThreadStoreActions {
  const turnsByThread: Record<string, Turn[]> = {};
  let eventsApplied = 0;

  const actions = {
    turns: vi.fn((threadId: string) => turnsByThread[threadId]),
    rename: vi.fn(),
    setStreamingThreadId: vi.fn(),
    ensureThread: vi.fn(),
    markHandoffPending: vi.fn(),
    appendUserTurn: vi.fn(),
    removeOptimisticUserTurn: vi.fn(),
    acknowledgeUserTurn: vi.fn(),
    ensureAssistantTurn: vi.fn((threadId: string, turnId: string) => {
      const turns = turnsByThread[threadId] ?? [];
      if (turns.some((turn) => turn.id === turnId)) return;
      turnsByThread[threadId] = [
        ...turns,
        {
          id: turnId,
          threadId,
          prevTurnId: turns.at(-1)?.id ?? null,
          role: "assistant",
          status: "streaming",
          finishReason: null,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalCostUsd: "0",
          responseCount: 0,
          usage: null,
          error: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          blocks: [],
          siblingIds: [],
          responses: [],
        },
      ];
    }),
    upsertAssistantBlock: vi.fn((threadId: string, turnId: string, block) => {
      const turns = turnsByThread[threadId] ?? [];
      turnsByThread[threadId] = turns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              blocks: [
                ...turn.blocks.filter((existing) => existing.sequence !== block.sequence),
                block,
              ].sort((a, b) => a.sequence - b.sequence),
            }
          : turn,
      );
    }),
    patchTurnStatus: vi.fn((threadId: string, turnId: string, status, patch = {}) => {
      const turns = turnsByThread[threadId] ?? [];
      turnsByThread[threadId] = turns.map((turn) =>
        turn.id === turnId ? { ...turn, ...patch, status } : turn,
      );
    }),
    pruneStaleAssistantTurns: vi.fn((threadId: string) => {
      const turns = turnsByThread[threadId] ?? [];
      turnsByThread[threadId] = turns.filter(
        (turn) => !(turn.role === "assistant" && turn.status === "streaming"),
      );
    }),
    bumpEventsApplied: vi.fn(() => {
      eventsApplied += 1;
      return eventsApplied;
    }),
    applyThreadSnapshot: vi.fn(),
    markPendingStream: vi.fn(),
    consumePendingStream: vi.fn(),
    markPendingCreation: vi.fn(),
    clearPendingCreation: vi.fn(),
  } satisfies ThreadStoreActions;

  return actions;
}

const thread: Thread = {
  id: "thread_1",
  workbenchId: "project_1",
  workId: null,
  userId: "user_1",
  kind: "primary",
  status: "active",
  title: "Thread",
  currentAgent: null,
  parentThreadId: null,
  rootThreadId: "thread_1",
  spawnDepth: 0,
  spawnStatus: null,
  totalCostUsd: "0",
  turnCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const assistantTurn: Turn = {
  id: "turn_1",
  threadId: "thread_1",
  prevTurnId: null,
  parentTurnId: null,
  role: "assistant",
  status: "complete",
  finishReason: "end_turn",
  model: null,
  provider: null,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  totalCostUsd: "0",
  responseCount: 0,
  usage: null,
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  blocks: [],
  siblingIds: [],
  responses: [],
};

const waitingCheckpointTurn: Turn = {
  ...assistantTurn,
  id: "turn_checkpoint",
  status: "waiting_checkpoint",
  finishReason: null,
  completedAt: null,
};

function makeSnapshot(): ThreadSnapshotResponse {
  return {
    threadId: "thread_1",
    thread,
    turns: [assistantTurn],
    liveState: {
      threadId: "thread_1",
      status: "active",
      runningTurnId: "turn_1",
      currentAgent: null,
      nextSeq: "10",
      resumeAfterSeq: "9",
    },
    waitingForUser: false,
    nextSeq: "10",
  };
}

function serverUserTurnFrom(optimisticTurn: Turn, serverTurnId: string): Turn {
  return {
    ...optimisticTurn,
    id: serverTurnId,
    blocks: optimisticTurn.blocks.map((block) => ({
      ...block,
      id: `${serverTurnId}-block-${block.sequence}`,
      turnId: serverTurnId,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ThreadRunController", () => {
  it("appends the user message, subscribes from streamCursor, applies events, and tears down on RUN_FINISHED", async () => {
    const transport = new FakeThreadTransport();
    const actions = makeActions();
    const appendUserMessageFn = vi.fn().mockResolvedValue({
      assistantTurnId: "turn_1",
      streamCursor: "42",
    });
    const controller = new ThreadRunController({ transport, actions, appendUserMessageFn });

    await controller.submit("thread_1", "Hello");

    expect(appendUserMessageFn).toHaveBeenCalledWith({
      data: {
        threadId: "thread_1",
        text: "Hello",
      },
    });
    expect(transport.subscribeThreadId).toBe("thread_1");
    expect(transport.subscribeOptions).toEqual({ after: "42" });

    transport.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" }, "43");
    transport.emit(
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_1", role: "assistant" },
      "44",
    );
    transport.emit({ type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "turn_1" }, "45");

    expect(actions.turns("thread_1")?.[0]).toMatchObject({
      id: "turn_1",
      status: "complete",
    });
    expect(transport.handlers).toBeNull();
  });

  it("acknowledges the optimistic user turn before snapshot reconcile so one server-id user turn remains", async () => {
    const transport = new FakeThreadTransport();
    const store = createThreadStore({ now: 0, queryClient: new QueryClient() });
    const optimisticTurn = store.getState().appendUserTurn("thread_1", "Hello");
    const appendUserMessageFn = vi.fn().mockResolvedValue({
      threadId: "thread_1",
      userTurnId: "turn_user_server",
      assistantTurnId: "turn_1",
      streamCursor: "42",
      status: "accepted",
    });
    const controller = new ThreadRunController({
      transport,
      actions: store.getState(),
      appendUserMessageFn,
    });

    expect(
      store
        .getState()
        .turns("thread_1")
        ?.map((turn) => turn.id),
    ).toEqual([optimisticTurn.id]);

    await controller.submit("thread_1", "Hello", { optimisticUserTurnId: optimisticTurn.id });
    store
      .getState()
      .applyThreadSnapshot(thread, [serverUserTurnFrom(optimisticTurn, "turn_user_server")]);

    const userTurns = store
      .getState()
      .turns("thread_1")
      ?.filter((turn) => turn.role === "user");
    expect(userTurns?.map((turn) => turn.id)).toEqual(["turn_user_server"]);
  });

  it("resumes from a cursor without requiring RUN_STARTED first", () => {
    const transport = new FakeThreadTransport();
    const actions = makeActions();
    const appendUserMessageFn = vi.fn();
    const controller = new ThreadRunController({ transport, actions, appendUserMessageFn });

    controller.resume("thread_1", { after: "100", expectedTurnId: "turn_1" });

    expect(appendUserMessageFn).not.toHaveBeenCalled();
    expect(transport.subscribeOptions).toEqual({ after: "100" });

    transport.emit(
      { type: EventType.TEXT_MESSAGE_START, messageId: "tail_msg", role: "assistant" },
      "101",
    );
    transport.emit({ type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "turn_1" }, "102");

    expect(actions.ensureAssistantTurn).toHaveBeenCalledWith("thread_1", "turn_1");
    expect(actions.turns("thread_1")?.[0]).toMatchObject({
      id: "turn_1",
      status: "complete",
    });
  });

  it("sends checkpoint responses through the transport", () => {
    const transport = new FakeThreadTransport();
    const actions = makeActions();
    const controller = new ThreadRunController({ transport, actions });

    controller.respondCheckpoint({
      threadId: "thread_1",
      turnId: "turn_1",
      checkpointId: "checkpoint_1",
      value: { value: "approved" },
    });

    expect(transport.respondCheckpoint).toHaveBeenCalledWith({
      threadId: "thread_1",
      turnId: "turn_1",
      checkpointId: "checkpoint_1",
      value: { value: "approved" },
    });
  });

  it("calls HTTP cancel for the active turn", async () => {
    const transport = new FakeThreadTransport();
    const actions = makeActions();
    const controller = new ThreadRunController({ transport, actions });

    controller.resume("thread_1", { after: "42", expectedTurnId: "turn_1" });
    controller.cancel("thread_1");
    await waitForCancel(transport);

    expect(transport.cancel).toHaveBeenCalledWith("thread_1", "turn_1");
  });

  it("cancels when Stop is requested before RUN_STARTED reveals the turn id", async () => {
    const transport = new FakeThreadTransport();
    const actions = makeActions();
    const controller = new ThreadRunController({ transport, actions });

    controller.resume("thread_1", { after: "42" });
    controller.cancel("thread_1");
    expect(transport.cancel).not.toHaveBeenCalled();

    transport.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" }, "43");
    await waitForCancel(transport);

    expect(transport.cancel).toHaveBeenCalledWith("thread_1", "turn_1");
  });

  it("drops cross-thread and superseded-run events before applying to the store", () => {
    const transport = new FakeThreadTransport();
    const actions = makeActions();
    const controller = new ThreadRunController({ transport, actions });

    controller.resume("thread_1", { after: "42", expectedTurnId: "turn_1" });
    transport.emit(
      { type: EventType.RUN_STARTED, threadId: "thread_child", runId: "turn_child" },
      "43",
      "thread_child",
    );
    transport.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_old" }, "44");
    transport.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" }, "45");

    expect(actions.ensureAssistantTurn).toHaveBeenCalledTimes(1);
    expect(actions.ensureAssistantTurn).toHaveBeenLastCalledWith("thread_1", "turn_1", {
      createdAt: expect.any(String),
    });
  });

  it("keeps one active subscription by tearing down the prior run before a new resume", () => {
    const transport = new FakeThreadTransport();
    const actions = makeActions();
    const controller = new ThreadRunController({ transport, actions });

    controller.resume("thread_1", { after: "1", expectedTurnId: "turn_1" });
    const firstHandlers = transport.handlers;
    controller.resume("thread_1", { after: "2", expectedTurnId: "turn_2" });

    expect(transport.subscribeCount).toBe(2);
    expect(transport.unsubscribeCount).toBe(1);

    firstHandlers?.onEvent({
      seq: "3",
      event: { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
    });
    transport.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_2" }, "4");

    expect(actions.ensureAssistantTurn).toHaveBeenCalledWith("thread_1", "turn_2", {
      createdAt: expect.any(String),
    });
    expect(actions.turns("thread_1")?.map((turn) => turn.id)).toEqual(["turn_2"]);
  });

  it("keeps a waiting checkpoint turn when submit fails before the server accepts a new run", async () => {
    const transport = new FakeThreadTransport();
    const store = createThreadStore({ now: 0, queryClient: new QueryClient() });
    store.setState({ turnsByThread: { thread_1: [waitingCheckpointTurn] } });
    const appendUserMessageFn = vi.fn().mockRejectedValue(new Error("Turn already running"));
    const controller = new ThreadRunController({
      transport,
      actions: store.getState(),
      appendUserMessageFn,
    });

    await expect(controller.submit("thread_1", "checkpoint response")).rejects.toThrow(
      "Turn already running",
    );

    expect(store.getState().turns("thread_1")).toEqual([waitingCheckpointTurn]);
    expect(transport.subscribeCount).toBe(0);
  });

  it("prunes an abandoned live assistant turn before submitting again after transport failure", async () => {
    const transport = new FakeThreadTransport();
    const actions = makeActions();
    const appendUserMessageFn = vi
      .fn()
      .mockResolvedValueOnce({
        assistantTurnId: "turn_1",
        streamCursor: "42",
      })
      .mockResolvedValueOnce({
        assistantTurnId: "turn_2",
        streamCursor: "100",
      });
    const controller = new ThreadRunController({ transport, actions, appendUserMessageFn });

    await controller.submit("thread_1", "first");
    transport.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" }, "43");
    transport.handlers?.onError?.(new Error("socket failed"));

    await controller.submit("thread_1", "second");
    transport.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_2" }, "101");

    expect(actions.turns("thread_1")?.map((turn) => turn.id)).toEqual(["turn_2"]);
    expect(actions.pruneStaleAssistantTurns).toHaveBeenCalledWith("thread_1");
  });

  it("fetches and applies one snapshot per thread while gap recovery is in flight", async () => {
    const transport = new FakeThreadTransport();
    const actions = makeActions();
    const snapshot = deferred<ThreadSnapshotResponse>();
    const getThreadSnapshotFn = vi.fn().mockReturnValue(snapshot.promise);
    const controller = new ThreadRunController({ transport, actions, getThreadSnapshotFn });

    controller.resume("thread_1", { after: "42", expectedTurnId: "turn_1" });
    transport.handlers?.onGap?.({ threadId: "thread_1", cause: "server_restart", gapCount: 1 });
    transport.handlers?.onGap?.({ threadId: "thread_1", cause: "server_restart", gapCount: 2 });

    expect(getThreadSnapshotFn).toHaveBeenCalledTimes(1);

    snapshot.resolve(makeSnapshot());
    await vi.waitFor(() => {
      expect(actions.ensureThread).toHaveBeenCalledWith(thread);
      expect(actions.applyThreadSnapshot).toHaveBeenCalledWith(thread, [assistantTurn], {
        runningTurnId: "turn_1",
        waitingForUser: false,
      });
    });
  });
});
