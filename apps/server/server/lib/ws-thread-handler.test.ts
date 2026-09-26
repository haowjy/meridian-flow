/** The advertised journal head never replaces the client's delivered cursor. */

import {
  EventType,
  type ThreadLiveState,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createNoopEventSink } from "../domains/observability/index.js";
import { appendSubagentActivity } from "../domains/runtime/spawn/activity-event.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
  readThreadActivity,
} from "../domains/threads/index.js";
import type { SequencedEventInternal } from "../domains/threads/thread-event-hub.js";
import { buildThreadSnapshot } from "../domains/threads/thread-snapshot.js";
import type { AppServices } from "./app.js";
import { createThreadWebSocketSession, type WsPeer } from "./ws-thread-handler.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000901" as ThreadId;
const USER_ID = "user-1" as UserId;
const UNDELIVERED_HEAD = 23_081_000n;

const LIVE_STATE: ThreadLiveState = {
  threadId: THREAD_ID,
  status: { kind: "asleep" as const },
  runningTurnId: null,
  activity: { children: [] },
  pending: { items: [] },
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
      JSON.stringify({ type: "subscribe", threadId: THREAD_ID, lastSeq: "0" }),
    );

    const subscribed = frames.find((frame) => frame.type === "subscribed");
    expect(subscribed).toMatchObject({ catchup: [] });
    expect(subscribed).not.toHaveProperty("nextSeq");

    // The separately sampled durable head may lead the live listener. The
    // client resumes from delivered event frames, not the durable head.
    deliverLive(UNDELIVERED_HEAD);
    expect(frames.at(-1)).toMatchObject({ type: "event", seq: UNDELIVERED_HEAD.toString() });
  });

  it("journals producer activity from the same read as the thread snapshot", async () => {
    const repos = createInMemoryRepositories();
    const parent = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const child = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: "project-1",
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      spawnDepth: 1,
      title: "Critic",
    });
    const journal = createInMemoryEventJournalWriter();
    const hub = createThreadEventHub({
      journalWriter: journal,
      journalReader: journal,
      eventSink: createNoopEventSink(),
    });
    const statusReader = {
      async read() {
        return { kind: "asleep" as const };
      },
      async readRunningTurnId() {
        return null;
      },
      async readMany() {
        return new Map();
      },
      async readPending() {
        return { items: [] };
      },
    };
    const readActivity = (threadId: ThreadId) =>
      readThreadActivity({ threads: repos.threads, statusReader }, threadId);

    await appendSubagentActivity({
      eventWriter: hub,
      readActivity,
      parentThreadId: parent.id as ThreadId,
      childThreadId: child.id,
    });

    const event = journal.getEvents(parent.id).at(-1)?.event;
    expect(event?.type).toBe("subagent.activity");
    if (event?.type !== "subagent.activity") throw new Error("Expected activity journal event");
    const liveRead = await readActivity(parent.id as ThreadId);
    const snapshot = await buildThreadSnapshot(repos, hub, statusReader, parent.id as ThreadId);
    expect(event.activity).toEqual(liveRead);
    expect(event.activity).toEqual(snapshot.liveState.activity);
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
