/** Ordered and cancellable socket handoff over the real journal hub. */
import type { WsServerMessage } from "@meridian/contracts/protocol";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { goldenAssistantTurn } from "../../../../packages/contracts/src/threads/golden/turn-fixture.js";
import { createNoopEventSink } from "../domains/observability/index.js";
import { createInMemoryEventJournalWriter } from "../domains/threads/adapters/in-memory/index.js";
import type { EventJournalReader } from "../domains/threads/ports/index.js";
import { createThreadEventHub } from "../domains/threads/thread-event-hub.js";
import type { AppServices } from "./app.js";
import { createThreadWebSocketSession, type WsPeer } from "./ws-thread-handler.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000901" as ThreadId;
const USER_ID = "user-1" as UserId;
const LIVE_STATE = {
  threadId: THREAD_ID,
  status: { kind: "asleep" as const },
  runningTurnId: null,
  activity: { descendants: [] },
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

describe("thread socket lease ownership", () => {
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
