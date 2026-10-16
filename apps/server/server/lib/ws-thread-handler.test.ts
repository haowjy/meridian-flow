/** Consolidated test contracts; each block retains its original fixture scope. */

import {
  EventType,
  type ThreadLiveState,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe as __mergedSuite, expect, it, vi } from "vitest";
import { goldenAssistantTurn } from "../../../../packages/contracts/src/threads/golden/turn-fixture.js";
import { createNoopEventSink } from "../domains/observability/index.js";
import { createInMemoryEventJournalWriter } from "../domains/threads/adapters/in-memory/index.js";
import type { EventJournalReader } from "../domains/threads/ports/index.js";
import {
  createThreadEventHub,
  type SequencedEventInternal,
} from "../domains/threads/thread-event-hub.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
import { EMPTY_RUN_STATE } from "../test-support/run-state.js";
import type { AppServices } from "./app.js";
import { createThreadWebSocketSession, type WsPeer } from "./ws-thread-handler.js";

__mergedSuite("ws-thread-handler.test.ts", () => {
  // Merged from apps/server/server/lib/ws-thread-handler.test.ts.
  const THREAD_ID = "00000000-0000-4000-8000-000000000901" as ThreadId;

  const USER_ID = "user-1" as UserId;

  const UNDELIVERED_HEAD = 23081000n;

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
      async catchupAndSubscribe(
        _threadId: ThreadId,
        _lastSeq: bigint,
        listener: typeof deliverLive,
      ) {
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

  __mergedSuite("thread WS handler subscribe handoff", () => {
    it("does not turn an undelivered advertised head into a client cursor", async () => {
      const { session, frames, deliverLive } = createDelayedDeliveryHarness();
      session.open();
      await session.onMessage(
        JSON.stringify({ type: "subscribe", threadId: THREAD_ID, lastSeq: "0" }),
      );
      const subscribed = frames.find((frame) => frame.type === "subscribed");
      expect(subscribed).toMatchObject({ catchup: [] });
      expect(subscribed).not.toHaveProperty("nextSeq");
      // The separately sampled durable head may lead the live listener. The
      // client resumes from delivered event frames, not the durable head.
      deliverLive(UNDELIVERED_HEAD);
      expect(frames.at(-1)).toMatchObject({
        type: "event",
        seq: UNDELIVERED_HEAD.toString(),
      });
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
    await session.onMessage(JSON.stringify({ type: "subscribe", threadId: THREAD_ID }));
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
      JSON.stringify({ type: "subscribe", threadId: THREAD_ID, lastSeq: "0" }),
    );
    await session.onMessage(
      JSON.stringify({
        type: "interrupt.respond",
        threadId: THREAD_ID,
        turnId: "00000000-0000-4000-8000-000000000902",
        interruptId: "ask-1",
        value: "yes",
      }),
    );
    const expected = {
      type: "error",
      threadId: THREAD_ID,
      kind: "error",
      error: {
        code: "not_found",
        message: "Thread not found",
        retryable: false,
        source: "system",
      },
    };
    expect(frames.filter((frame) => frame.type === "error")).toEqual([expected, expected]);
    session.onClose();
  });
});

__mergedSuite("ws-thread-handler.handoff.test.ts", () => {
  // Merged from apps/server/server/lib/ws-thread-handler.handoff.test.ts.
  const THREAD_ID = "00000000-0000-4000-8000-000000000901" as ThreadId;

  const USER_ID = "user-1" as UserId;

  const LIVE_STATE = {
    threadId: THREAD_ID,
    status: { kind: "asleep" as const },
    runningTurnId: null,
    activity: { children: [] },
    pending: { items: [] },
    resumeAfterSeq: "0",
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  async function harness(
    options: {
      liveState?: () => Promise<typeof LIVE_STATE>;
      authorize?: () => Promise<void>;
      readGate?: Promise<void>;
      onReadBlocked?: () => void;
      firstCatchupGate?: Promise<void>;
      onFirstCatchupReady?: () => void;
    } = {},
  ) {
    const journal = createInMemoryEventJournalWriter();
    await journal.appendEvent(THREAD_ID, {
      type: "turn.created",
      turn: goldenAssistantTurn("turn-handoff", THREAD_ID),
    });
    await journal.appendEvent(THREAD_ID, { type: "stream.delta", kind: "text", text: "a" });
    await journal.appendEvent(THREAD_ID, {
      type: "stream.delta",
      kind: "tool_call",
      toolCallId: "tool-handoff",
      toolName: "lookup",
      argumentsDelta: "{}",
    });
    const sink = createNoopEventSink();
    let blockRead = Boolean(options.readGate);
    const reader: EventJournalReader = {
      ...journal,
      async readAfter(threadId, afterSeq, limit) {
        if (blockRead) {
          blockRead = false;
          options.onReadBlocked?.();
          await options.readGate;
        }
        return journal.readAfter(threadId, afterSeq, limit);
      },
    };
    const hub = createThreadEventHub(
      { journalReader: reader, journalWriter: journal, eventSink: sink },
      { evictionGraceMs: 5 },
    );
    let catchupCalls = 0;
    const threadEventHub = options.firstCatchupGate
      ? {
          ...hub,
          async catchupAndSubscribe(...args: Parameters<typeof hub.catchupAndSubscribe>) {
            const result = await hub.catchupAndSubscribe(...args);
            if (++catchupCalls === 1) {
              options.onFirstCatchupReady?.();
              await options.firstCatchupGate;
            }
            return result;
          },
        }
      : hub;
    const app = {
      eventSink: sink,
      threadEventHub,
      hub,
      threadRuntime: {
        requireOwnedThread: options.authorize ?? (async () => {}),
        liveState: options.liveState ?? (async () => LIVE_STATE),
      },
    } as unknown as AppServices;
    const frames: WsServerMessage[] = [];
    let closes = 0;
    let failType: string | undefined;
    const peer: WsPeer = {
      request: new Request("https://app.localhost/api/threads/ws"),
      context: { app, userId: USER_ID, traceId: "handoff" },
      send(raw) {
        const frame = JSON.parse(raw) as WsServerMessage;
        if (frame.type === failType) throw new Error("injected send failure");
        frames.push(frame);
      },
      close() {
        closes++;
      },
    };
    const session = createThreadWebSocketSession(peer);
    session.open();
    const subscribe = (lastSeq = "0") =>
      session.onMessage(JSON.stringify({ type: "subscribe", threadId: THREAD_ID, lastSeq }));
    const unsubscribe = () =>
      session.onMessage(JSON.stringify({ type: "unsubscribe", threadId: THREAD_ID }));
    const appendLive = async () => {
      await hub.appendEvent(THREAD_ID, { type: "stream.delta", kind: "text", text: "b" });
      await hub.appendEvent(THREAD_ID, {
        type: "tool.result",
        toolCallId: "tool-handoff",
        output: "complete",
        isError: false,
      });
    };
    return {
      hub,
      frames,
      session,
      subscribe,
      unsubscribe,
      appendLive,
      setFailType: (type?: string) => {
        failType = type;
      },
      getCloses: () => closes,
    };
  }

  const seqs = (frames: WsServerMessage[]) =>
    frames.flatMap((frame) =>
      frame.type === "subscribed"
        ? frame.catchup.map((entry) => entry.seq)
        : frame.type === "event"
          ? [frame.seq]
          : [],
    );

  it("sends historical text/tool catchup before live frames when live state is delayed", async () => {
    const gate = deferred<never>();
    const entered = deferred<void>();
    const options = {
      liveState: async () => {
        entered.resolve();
        await gate.promise;
        return LIVE_STATE;
      },
    };
    const h = await harness(options);
    const pending = h.subscribe();
    await entered.promise;
    await h.appendLive();
    expect(h.frames.map((frame) => frame.type)).toEqual(["connected"]);
    gate.resolve(undefined as never);
    await pending;
    expect(h.frames.slice(0, 2).map((frame) => frame.type)).toEqual(["connected", "subscribed"]);
    expect(h.frames.slice(2).every((frame) => frame.type === "event")).toBe(true);
    const delivered = seqs(h.frames);
    expect(delivered).toEqual([...new Set(delivered)]);
    expect(delivered).toEqual([...delivered].sort((a, b) => Number(BigInt(a) - BigInt(b))));
    const eventTypes = h.frames
      .filter((frame) => frame.type === "event")
      .map((frame) => frame.event.type);
    expect(eventTypes).toContain("TEXT_MESSAGE_CONTENT");
    expect(eventTypes).toContain("TOOL_CALL_RESULT");
    h.session.onClose();
  });

  __mergedSuite("thread socket lease ownership", () => {
    it("releases an older hub result that resolves after its replacement", async () => {
      const gate = deferred<void>();
      const ready = deferred<void>();
      const h = await harness({
        firstCatchupGate: gate.promise,
        onFirstCatchupReady: () => ready.resolve(),
      });
      const old = h.subscribe();
      await ready.promise;
      await h.subscribe();
      gate.resolve();
      await old;
      expect(h.frames.filter((frame) => frame.type === "subscribed")).toHaveLength(1);
      await h.unsubscribe();
      await vi.waitFor(() => expect(h.hub.hasThreadState(THREAD_ID)).toBe(false));
    });
    for (const cancel of ["unsubscribe", "close", "replace"] as const) {
      it(`releases a stale real-hub catchup after ${cancel}`, async () => {
        const gate = deferred<void>();
        const entered = deferred<void>();
        const h = await harness({ readGate: gate.promise, onReadBlocked: () => entered.resolve() });
        const old = h.subscribe();
        await entered.promise;
        if (cancel === "unsubscribe") await h.unsubscribe();
        else if (cancel === "close") h.session.onClose();
        const newer = cancel === "replace" ? h.subscribe() : undefined;
        gate.resolve();
        await old;
        await newer;
        expect(h.frames.filter((frame) => frame.type === "subscribed")).toHaveLength(
          cancel === "replace" ? 1 : 0,
        );
        if (cancel === "replace") await h.unsubscribe();
        await vi.waitFor(() => expect(h.hub.hasThreadState(THREAD_ID)).toBe(false));
      });
    }
    for (const cancel of ["unsubscribe", "close", "replace"] as const) {
      it(`invalidates pending catchup on ${cancel}`, async () => {
        const gate = deferred<typeof LIVE_STATE>();
        const entered = deferred<void>();
        let calls = 0;
        const h = await harness({
          liveState: async () => {
            if (++calls === 1) {
              entered.resolve();
              return gate.promise;
            }
            return LIVE_STATE;
          },
        });
        const old = h.subscribe();
        await entered.promise;
        if (cancel === "unsubscribe") await h.unsubscribe();
        else if (cancel === "close") h.session.onClose();
        else await h.subscribe();
        gate.resolve(LIVE_STATE);
        await old;
        expect(h.frames.filter((frame) => frame.type === "subscribed")).toHaveLength(
          cancel === "replace" ? 1 : 0,
        );
        if (cancel === "replace") await h.unsubscribe();
        await vi.waitFor(() => expect(h.hub.hasThreadState(THREAD_ID)).toBe(false));
      });
    }
    it("keeps an active lease when replacement authorization fails", async () => {
      let calls = 0;
      const h = await harness({
        authorize: async () => {
          if (++calls === 2) throw Error("denied");
        },
      });
      await h.subscribe();
      await h.subscribe();
      await h.appendLive();
      expect(h.frames.filter((frame) => frame.type === "subscribed")).toHaveLength(1);
      expect(h.frames.filter((frame) => frame.type === "error")).toHaveLength(1);
      expect(h.frames.filter((frame) => frame.type === "event").length).toBeGreaterThan(0);
      h.session.onClose();
    });
    it("admits only the newest request when authorization resolves out of order", async () => {
      const firstAuth = deferred<void>();
      const entered = deferred<void>();
      let calls = 0;
      const h = await harness({
        authorize: async () => {
          if (++calls === 1) {
            entered.resolve();
            await firstAuth.promise;
          }
        },
      });
      const old = h.subscribe();
      await entered.promise;
      await h.subscribe();
      firstAuth.resolve();
      await old;
      expect(h.frames.filter((frame) => frame.type === "subscribed")).toHaveLength(1);
      await h.appendLive();
      expect(h.frames.filter((frame) => frame.type === "event").length).toBeGreaterThan(0);
      h.session.onClose();
    });
    for (const failType of ["subscribed", "event"] as const) {
      it(`disposes the lease when ${failType} send fails`, async () => {
        const gate = deferred<typeof LIVE_STATE>();
        const entered = deferred<void>();
        const h = await harness({
          liveState: async () => {
            entered.resolve();
            return gate.promise;
          },
        });
        const pending = h.subscribe();
        await entered.promise;
        await h.appendLive();
        h.setFailType(failType);
        gate.resolve(LIVE_STATE);
        await pending;
        expect(h.getCloses()).toBe(1);
        expect(h.frames.filter((frame) => frame.type === "event")).toHaveLength(0);
        await vi.waitFor(() => expect(h.hub.hasThreadState(THREAD_ID)).toBe(false));
      });
    }
    it("disposes an active listener after live send failure", async () => {
      const h = await harness();
      await h.subscribe();
      h.setFailType("event");
      await h.appendLive();
      expect(h.getCloses()).toBe(1);
      expect(h.frames.filter((frame) => frame.type === "event")).toHaveLength(0);
      await vi.waitFor(() => expect(h.hub.hasThreadState(THREAD_ID)).toBe(false));
    });
  });
});
