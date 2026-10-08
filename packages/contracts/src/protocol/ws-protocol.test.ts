/** Thread socket decoding contracts for live state and context catalog wakes. */
import { expect, it } from "vitest";
import {
  encodeWsServerMessage,
  parseWsServerMessage,
  type WsServerMessage,
} from "./ws-protocol.js";

it("decodes a subscription while the thread is compacting", () => {
  expect(
    parseWsServerMessage(
      JSON.stringify({
        type: "subscribed",
        threadId: "thread",
        catchup: [],
        state: {
          threadId: "thread",
          status: { kind: "awake", phase: "compacting", cancelRequested: false },
          runningTurnId: "summary",
          activity: { children: [] },
          pending: { items: [] },
          resumeAfterSeq: "0",
        },
      }),
    ),
  ).not.toBeNull();
});

it("decodes an encoded lineage catalog wake hint", () => {
  const hint: WsServerMessage = {
    type: "context-catalog-hint",
    scope: { kind: "lineage", projectId: "project", rootThreadId: "root-thread" },
    headRevision: "7",
  };

  expect(parseWsServerMessage(encodeWsServerMessage(hint))).toEqual(hint);
});
