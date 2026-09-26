/**
 * The pending inbox selector and `meridian.inbox.changed` live replacement.
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { pendingInboxFromEvent, writerTurnQueueStatus } from "./pending-inbox";

describe("pendingInboxFromEvent", () => {
  const pending = {
    items: [
      {
        id: "message-1",
        seq: 1,
        intent: "message",
        provenance: { kind: "writer", actorId: "user-1" },
        deliveryState: "waiting",
        summary: "queued",
        enqueuedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  it("returns the inbox from the inbox.changed frame", () => {
    expect(
      pendingInboxFromEvent({
        type: EventType.CUSTOM,
        name: "meridian.inbox.changed",
        value: pending,
      }),
    ).toEqual(pending);
  });

  it("ignores unrelated custom frames and malformed values", () => {
    expect(
      pendingInboxFromEvent({
        type: EventType.CUSTOM,
        name: "meridian.subagent.activity",
        value: pending,
      }),
    ).toBeNull();
    expect(
      pendingInboxFromEvent({
        type: EventType.CUSTOM,
        name: "meridian.inbox.changed",
        value: { nope: true },
      }),
    ).toBeNull();
    expect(pendingInboxFromEvent({ type: EventType.RUN_STARTED })).toBeNull();
  });
});

describe("writerTurnQueueStatus", () => {
  it("selects one status per writer turn and excludes child/system notices", () => {
    const writer = {
      id: "writer",
      seq: 1,
      intent: "message" as const,
      provenance: { kind: "writer" as const, actorId: "writer-1" },
      deliveryState: "waiting" as const,
      summary: "writer message",
      enqueuedAt: "2026-01-01T00:00:00.000Z",
    };
    const child = {
      ...writer,
      id: "child",
      seq: 2,
      provenance: {
        kind: "child" as const,
        threadId: "child-thread",
        reportId: "execution",
        handle: "p1",
        outcome: "succeeded",
      },
      summary: "child report notification",
    };
    const agent = {
      ...writer,
      id: "agent",
      seq: 3,
      provenance: { kind: "agent" as const, threadId: "agent-thread" },
      summary: "agent message",
    };
    const system = {
      ...writer,
      id: "system",
      seq: 4,
      provenance: { kind: "system" as const, source: "runtime" },
      summary: "system notice",
    };
    const inbox = { items: [writer, child, agent, system] };

    const statuses = writerTurnQueueStatus(inbox);
    expect(statuses.size).toBe(1);
    expect(statuses.get("writer")).toBe("queued");
    expect(statuses.has("child")).toBe(false);
    expect(statuses.has("system")).toBe(false);
  });
});
