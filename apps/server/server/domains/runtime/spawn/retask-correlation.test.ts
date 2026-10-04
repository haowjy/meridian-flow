/** Which adopted messages make a subagent run report back to its parent. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type { InboxMessage } from "../loop/ports.js";
import { parentRetaskCorrelation } from "./retask-correlation.js";

const child = { id: "child-1", kind: "subagent", parentThreadId: "parent-1" } as Thread;

function message(provenance: InboxMessage["provenance"], seq = 1): InboxMessage {
  return {
    id: `m-${seq}`,
    seq,
    threadId: child.id as ThreadId,
    intent: "message",
    provenance,
    body: { kind: "text", text: "Again" },
    idempotencyKey: `k-${seq}`,
    enqueuedAt: "2026-10-03T00:00:00.000Z",
    deliveredAt: null,
  };
}

describe("parentRetaskCorrelation", () => {
  it("reports a parent's re-task back to the parent with a completion notice", () => {
    expect(
      parentRetaskCorrelation(child, [
        message({ kind: "writer", actorId: "u1" }, 1),
        message(
          { kind: "agent", threadId: "parent-1", notify: { turnId: "t1", toolCallId: "c1" } },
          2,
        ),
        message(
          { kind: "agent", threadId: "parent-1", notify: { turnId: "t2", toolCallId: "c2" } },
          3,
        ),
      ]),
    ).toEqual({
      callerThreadId: "parent-1",
      callerTurnId: "t2",
      toolCallId: "c2",
      cardBlockId: null,
      origin: "message",
      deliveryMode: "background_notification",
    });
  });
});
