/** A client joining a pending summary must accept the live compaction phase. */
import { expect, it } from "vitest";
import { parseWsServerMessage } from "./ws-protocol.js";

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
