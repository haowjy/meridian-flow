import { describe, expect, it } from "vitest";
import type { ControlBody } from "../threads/index.js";
import { encodeWsServerMessage, parseWsServerMessage } from "./ws-protocol.js";

function subscribedFrameWithQueuedControl(control: ControlBody): string {
  return JSON.stringify({
    type: "subscribed",
    threadId: "thread-1",
    catchup: [],
    state: {
      threadId: "thread-1",
      status: { kind: "awake", phase: "generating", cancelRequested: false },
      runningTurnId: "turn-1",
      activity: { children: [] },
      pending: {
        items: [
          {
            id: "control-1",
            seq: 7,
            intent: "control",
            control,
            provenance: { kind: "writer", actorId: "user-1" },
            deliveryState: "waiting",
            summary: "",
            enqueuedAt: "2026-10-11T00:00:00.000Z",
          },
        ],
      },
      resumeAfterSeq: "6",
    },
  });
}

describe("thread socket frames", () => {
  it.each<ControlBody>([
    { kind: "compact", instructions: "keep the duel" },
    { kind: "write_mode", mode: "direct" },
    { kind: "write_mode", mode: "draft" },
  ])("round-trips a subscription with a queued $kind control", (control) => {
    const parsed = parseWsServerMessage(subscribedFrameWithQueuedControl(control));

    expect(parsed?.type).toBe("subscribed");
    if (parsed?.type !== "subscribed") return;
    expect(parsed.state.pending.items[0]?.control).toEqual(control);
    expect(parseWsServerMessage(encodeWsServerMessage(parsed))).toEqual(parsed);
  });

  it("rejects a control outside the vocabulary", () => {
    const frame = subscribedFrameWithQueuedControl({ kind: "write_mode", mode: "review" } as never);

    expect(parseWsServerMessage(frame)).toBeNull();
  });
});
