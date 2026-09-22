/**
 * Server-side gap contract for the thread WS handler.
 *
 * When a client's cursor falls behind the journal replay cap, the handler must
 * tell the client where to resume: the gap frame carries the requested
 * `fromSeq` and the journal head as `toSeq`. Resuming from that head must be
 * past the cap, or the client would gap forever.
 */

import type { WsServerMessage } from "@meridian/contracts/protocol";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createNoopEventSink } from "../domains/observability/index.js";
import type { EventJournalReader, JournalEntry } from "../domains/threads/ports/index.js";
import { createThreadEventHub } from "../domains/threads/thread-event-hub.js";
import type { AppServices } from "./app.js";
import { createThreadWebSocketSession, type WsPeer } from "./ws-thread-handler.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000901" as ThreadId;
const USER_ID = "user-1" as UserId;
const WINDOW_ROWS = 10_000;
const HEAD_JOURNAL_SEQ = 23_081n;
const HEAD_CURSOR = HEAD_JOURNAL_SEQ * 1_000n + 999n;

const LIVE_STATE = {
  threadId: THREAD_ID,
  status: { kind: "asleep" as const },
  runningTurnId: null,
  activity: { descendants: [] },
  pending: { items: [] },
  resumeAfterSeq: "0",
};

/**
 * A reader whose oldest replay window is the 10k-row cap while the journal head
 * is far past it — the shape every long agent run reaches.
 */
function cappedWindowReader(): EventJournalReader {
  const payload = {
    type: "background.started" as const,
    parentThreadId: THREAD_ID,
    parentTurnId: "00000000-0000-4000-8000-000000000902",
    childThreadId: "child-1",
    agentSlug: "code-reviewer",
    description: "Review the chapter",
  };
  const entries: JournalEntry[] = Array.from({ length: WINDOW_ROWS }, (_, index) => ({
    id: `event-${index}`,
    threadId: THREAD_ID,
    turnId: null,
    seq: BigInt(index + 1),
    eventType: payload.type,
    payload,
    createdAt: new Date(0).toISOString(),
  }));

  return {
    async readAfter(_threadId, afterSeq, limit = Number.POSITIVE_INFINITY) {
      return entries.filter((entry) => entry.seq > afterSeq).slice(0, limit);
    },
    async headSeq() {
      return HEAD_JOURNAL_SEQ;
    },
    async readModelProjectionWatermark() {
      return 0n;
    },
    async listByThread() {
      return entries;
    },
    async listByType() {
      return [];
    },
    async listSince() {
      return [];
    },
    async listByTimeRange() {
      return [];
    },
  };
}

function createHarness() {
  const hub = createThreadEventHub({
    journalWriter: {
      async appendEvent() {
        return 0n;
      },
    },
    journalReader: cappedWindowReader(),
    eventSink: createNoopEventSink(),
  });
  const app = {
    eventSink: createNoopEventSink(),
    threadEventHub: hub,
    hub,
    threadRuntime: {
      async requireOwnedThread() {},
      async liveState() {
        return LIVE_STATE;
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

  return { session: createThreadWebSocketSession(peer), frames };
}

describe("thread WS handler gap frame", () => {
  it("carries fromSeq/toSeq when catch-up exceeds the replay cap", async () => {
    const { session, frames } = createHarness();
    session.open();
    await session.onMessage(
      JSON.stringify({ type: "subscribe", threadId: THREAD_ID, lastSeq: "0" }),
    );

    const gap = frames.find((frame) => frame.type === "gap");
    expect(gap).toEqual({
      type: "gap",
      threadId: THREAD_ID,
      cause: "replay_limit_exceeded",
      fromSeq: "0",
      toSeq: HEAD_CURSOR.toString(),
      message: "Journal replay capped at 10000 events",
    });
    const subscribed = frames.find((frame) => frame.type === "subscribed");
    expect(subscribed).toMatchObject({ nextSeq: (HEAD_CURSOR + 1n).toString() });
  });

  it("does not gap again when resuming from the head it advertised", async () => {
    const { session, frames } = createHarness();
    session.open();
    await session.onMessage(
      JSON.stringify({ type: "subscribe", threadId: THREAD_ID, lastSeq: "0" }),
    );
    const afterFirst = frames.length;

    await session.onMessage(
      JSON.stringify({
        type: "subscribe",
        threadId: THREAD_ID,
        lastSeq: HEAD_CURSOR.toString(),
      }),
    );

    expect(frames.slice(afterFirst).map((frame) => frame.type)).toEqual(["subscribed"]);
  });
});
