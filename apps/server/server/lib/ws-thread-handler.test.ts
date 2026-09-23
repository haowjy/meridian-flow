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
import type { AppServices } from "./app.js";
import { createThreadWebSocketSession, type WsPeer } from "./ws-thread-handler.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000901" as ThreadId;
const USER_ID = "user-1" as UserId;
const UNDELIVERED_HEAD = 23_081_000n;

const LIVE_STATE = {
  threadId: THREAD_ID,
  status: { kind: "asleep" as const },
  runningTurnId: null,
  activity: { descendants: [] },
  pending: { items: [] },
  resumeAfterSeq: "0",
};

function createDelayedDeliveryHarness() {
  let deliverLive!: (entry: { seq: bigint; event: { type: "RAW" } }) => void;
  const hub = {
    async catchupAndSubscribe(_threadId: ThreadId, _lastSeq: bigint, listener: typeof deliverLive) {
      deliverLive = listener;
      return { catchup: [], unsubscribe() {} };
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

  return {
    session: createThreadWebSocketSession(peer),
    frames,
    deliverLive: (seq: bigint) => deliverLive({ seq, event: { type: "RAW" } }),
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
    expect(subscribed).toMatchObject({ catchup: [], nextSeq: (UNDELIVERED_HEAD + 1n).toString() });

    // The separately sampled durable head may lead the live listener. The
    // client resumes from delivered event frames, not subscribed.nextSeq.
    deliverLive(UNDELIVERED_HEAD);
    expect(frames.at(-1)).toMatchObject({ type: "event", seq: UNDELIVERED_HEAD.toString() });
  });
});
