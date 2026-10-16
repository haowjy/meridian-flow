/** The advertised journal head never replaces the client's delivered cursor. */

import {
  EventType,
  type ThreadLiveState,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createNoopEventSink } from "../domains/observability/index.js";
import type { SequencedEventInternal } from "../domains/threads/thread-event-hub.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
import { EMPTY_RUN_STATE } from "../test-support/run-state.js";
import type { AppServices } from "./app.js";
import { createThreadWebSocketSession, type WsPeer } from "./ws-thread-handler.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000901" as ThreadId;
const USER_ID = "user-1" as UserId;
const UNDELIVERED_HEAD = 23_081_000n;

const LIVE_STATE: ThreadLiveState = {
  threadId: THREAD_ID,
  status: { kind: "asleep" as const },
  activity: { children: [] },
  runState: EMPTY_RUN_STATE,
  resumeAfterSeq: "0",
};

function createDelayedDeliveryHarness(
  catchup: SequencedEventInternal[] = [],
  liveState = LIVE_STATE,
) {
  let deliverLive!: (entry: SequencedEventInternal) => void;
  const hub = {
    async catchupAndSubscribe(_threadId: ThreadId, _lastSeq: bigint, listener: typeof deliverLive) {
      deliverLive = listener;
      return { catchup, unsubscribe() {} };
    },
    async headSeq() {
      return UNDELIVERED_HEAD;
    },
  };
  const app = {
    eventSink: createNoopEventSink(),
    threadEventHub: hub,
    hub,
    threadRuntime: {
      async requireOwnedThread() {},
      async liveState() {
        return liveState;
      },
    },
  } as unknown as AppServices;

  const frames: WsServerMessage[] = [];
  const peer: WsPeer = {
    request: new Request("https://app.localhost/api/threads/ws"),
    context: { app, userId: USER_ID, traceId: "gap-test" },
    send: (data) => frames.push(JSON.parse(data) as WsServerMessage),
    close: () => {},
  };

  return {
    session: createThreadWebSocketSession(peer),
    frames,
    deliverLive: (seq: bigint) => deliverLive({ seq, event: { type: EventType.RAW, event: {} } }),
    deliverEntry: (entry: SequencedEventInternal) => deliverLive(entry),
  };
}

describe("thread WS handler subscribe handoff", () => {
  it("does not turn an undelivered advertised head into a client cursor", async () => {
    const { session, frames, deliverLive } = createDelayedDeliveryHarness();
    session.open();
    await session.onMessage(
      JSON.stringify({ type: "subscribe", requestId: "r1", threadId: THREAD_ID, lastSeq: "0" }),
    );

    const subscribed = frames.find((frame) => frame.type === "subscribed");
    expect(subscribed).toMatchObject({ requestId: "r1", after: "0", catchup: [] });
    expect(subscribed).not.toHaveProperty("nextSeq");

    // The separately sampled durable head may lead the live listener. The
    // client resumes from delivered event frames, not the durable head.
    deliverLive(UNDELIVERED_HEAD);
    expect(frames.at(-1)).toMatchObject({ type: "event", seq: UNDELIVERED_HEAD.toString() });
  });
});

it("preserves typed errors in catchup and live envelopes", async () => {
  const error = {
    code: "credits_exhausted",
    message: "No credits",
    retryable: false,
    source: "system" as const,
    details: { needed: 10 },
  };
  const entry: SequencedEventInternal = {
    seq: 1000n,
    event: { type: EventType.RUN_ERROR, message: error.message },
    error,
  };
  const { session, frames, deliverEntry } = createDelayedDeliveryHarness([entry]);
  await session.onMessage(
    JSON.stringify({ type: "subscribe", requestId: "r1", threadId: THREAD_ID }),
  );
  expect(frames.at(-1)).toMatchObject({ catchup: [{ seq: "1000", error }] });
  deliverEntry({ ...entry, seq: 2000n });
  expect(frames.at(-1)).toMatchObject({ type: "event", seq: "2000", error });
});

// HTTP availability proofs never become attested WebSocket disappearance proofs.
it.each([
  "thread_not_found",
  "thread_deleted",
])("keeps %s subscribe and interrupt.respond refusals as identical unattested not_found frames", async (code) => {
  const frames: WsServerMessage[] = [];
  const app = {
    eventSink: createNoopEventSink(),
    threadRuntime: {
      requireOwnedThread: async () =>
        throwHttpInterrupt(
          {
            code,
            message: code === "thread_deleted" ? "Thread deleted" : "Thread not found",
            retryable: false,
            source: "system",
            details: { authenticatedUserId: USER_ID },
          },
          404,
        ),
    },
  } as unknown as AppServices;
  const session = createThreadWebSocketSession({
    request: new Request("https://app.localhost/api/threads/ws"),
    context: { app, userId: USER_ID, traceId: "concealment-test" },
    send: (data) => frames.push(JSON.parse(data) as WsServerMessage),
    close() {},
  });
  session.open();
  await session.onMessage(
    JSON.stringify({ type: "subscribe", requestId: "r1", threadId: THREAD_ID, lastSeq: "0" }),
  );
  await session.onMessage(
    JSON.stringify({
      type: "interrupt.respond",
      requestId: "r2",
      threadId: THREAD_ID,
      turnId: "00000000-0000-4000-8000-000000000902",
      interruptId: "ask-1",
      value: "yes",
    }),
  );
  const expected = (requestId: string) => ({
    type: "error",
    requestId,
    threadId: THREAD_ID,
    kind: "error",
    error: {
      code: "not_found",
      message: "Thread not found",
      retryable: false,
      source: "system",
    },
  });
  expect(frames.filter((frame) => frame.type === "error")).toEqual([
    expected("r1"),
    expected("r2"),
  ]);
  session.onClose();
});

function createRequestHarness(options: {
  liveState: (threadId: ThreadId) => Promise<ThreadLiveState>;
  projectRepo?: unknown;
  contextCatalogWakeHub?: unknown;
}) {
  const unsubscribed: ThreadId[] = [];
  const app = {
    eventSink: createNoopEventSink(),
    threadEventHub: {
      async catchupAndSubscribe(threadId: ThreadId) {
        return { catchup: [], unsubscribe: () => unsubscribed.push(threadId) };
      },
    },
    projectRepo: options.projectRepo,
    contextCatalogWakeHub: options.contextCatalogWakeHub,
    threadRuntime: {
      async requireOwnedThread() {},
      liveState: options.liveState,
    },
  } as unknown as AppServices;
  const frames: WsServerMessage[] = [];
  const session = createThreadWebSocketSession({
    request: new Request("https://app.localhost/api/threads/ws"),
    context: { app, userId: USER_ID, traceId: "request-test" },
    send: (data) => frames.push(JSON.parse(data) as WsServerMessage),
    close() {},
  });
  session.open();
  return { session, frames, unsubscribed };
}

describe("thread WS handler request ids", () => {
  it("answers a failed read with a retryable error naming the request, and disposes the lease", async () => {
    const { session, frames, unsubscribed } = createRequestHarness({
      liveState: async () => {
        throw new Error("db down");
      },
    });
    await session.onMessage(
      JSON.stringify({ type: "subscribe", requestId: "r9", threadId: THREAD_ID }),
    );
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      requestId: "r9",
      threadId: THREAD_ID,
      error: { retryable: true },
    });
    expect(unsubscribed).toEqual([THREAD_ID]);
  });

  it("echoes the request id from the outer catch", async () => {
    const { session, frames } = createRequestHarness({
      liveState: async () => LIVE_STATE,
      projectRepo: {
        findById: async () => {
          throw new Error("db down");
        },
      },
    });
    await session.onMessage(
      JSON.stringify({
        type: "catalog.subscribe",
        requestId: "r4",
        projectId: "00000000-0000-4000-8000-000000000777",
      }),
    );
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      requestId: "r4",
      error: { code: "internal" },
    });
  });

  it("serves two threads' subscribes concurrently", async () => {
    const other = "00000000-0000-4000-8000-000000000902" as ThreadId;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session, frames } = createRequestHarness({
      liveState: async (threadId) => {
        if (threadId === THREAD_ID) await gate;
        return { ...LIVE_STATE, threadId };
      },
    });
    const slow = session.onMessage(
      JSON.stringify({ type: "subscribe", requestId: "r1", threadId: THREAD_ID }),
    );
    await session.onMessage(
      JSON.stringify({ type: "subscribe", requestId: "r2", threadId: other }),
    );
    expect(frames.filter((frame) => frame.type === "subscribed")).toMatchObject([
      { requestId: "r2", threadId: other },
    ]);
    release();
    await slow;
    expect(frames.filter((frame) => frame.type === "subscribed")).toHaveLength(2);
    session.onClose();
  });
});

it.each([
  "close",
  "unsubscribe",
])("cancels catalog acquisition when %s wins the ownership read", async (outcome) => {
  let resolve!: (project: unknown) => void;
  const ownership = new Promise((done) => {
    resolve = done;
  });
  let listeners = 0;
  const { session } = createRequestHarness({
    liveState: async () => LIVE_STATE,
    projectRepo: { findById: () => ownership },
    contextCatalogWakeHub: {
      subscribe: () => {
        listeners++;
        return () => {
          listeners--;
        };
      },
    },
  });
  const projectId = "00000000-0000-4000-8000-000000000777";
  const pending = session.onMessage(
    JSON.stringify({ type: "catalog.subscribe", requestId: "r1", projectId }),
  );
  if (outcome === "close") session.onClose();
  else
    await session.onMessage(
      JSON.stringify({ type: "catalog.unsubscribe", requestId: "r2", projectId }),
    );
  resolve({ userId: USER_ID, deletedAt: null });
  try {
    await pending;
    expect(listeners).toBe(0);
  } finally {
    session.onClose();
  }
});
