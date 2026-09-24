/**
 * The pending tray reads the wire-shaped inbox and only from the
 * `meridian.inbox.changed` frame; unrelated or malformed frames are ignored.
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  awaitingRunTurnIds,
  EMPTY_THREAD_PENDING_INBOX,
  isThreadPendingInbox,
  pendingInboxFromEvent,
  writerPendingInbox,
} from "./pending-inbox";

describe("isThreadPendingInbox", () => {
  it("accepts an object with an items array", () => {
    expect(isThreadPendingInbox({ items: [] })).toBe(true);
    expect(isThreadPendingInbox(EMPTY_THREAD_PENDING_INBOX)).toBe(true);
  });

  it("rejects a missing items array and non-objects", () => {
    expect(isThreadPendingInbox({})).toBe(false);
    expect(isThreadPendingInbox([])).toBe(false);
    expect(isThreadPendingInbox(null)).toBe(false);
    expect(isThreadPendingInbox("pending")).toBe(false);
  });
});

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

describe("writerPendingInbox", () => {
  it("filters only the writer tray while retaining generic child and agent entries", () => {
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
      provenance: { kind: "child" as const, threadId: "child-thread", reportId: "execution" },
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

    expect(inbox.items).toHaveLength(4);
    expect(writerPendingInbox(inbox)).toEqual({ items: [writer] });
  });

  it("keeps accepted idle sends inline and excludes them from the tray", () => {
    const waiting = {
      id: "waiting-turn",
      seq: 1,
      intent: "message" as const,
      provenance: { kind: "writer" as const, actorId: "writer-1" },
      deliveryState: "waiting" as const,
      summary: "later",
      enqueuedAt: "2026-01-01T00:00:00.000Z",
    };
    const awaiting = { ...waiting, id: "awaiting-turn", deliveryState: "awaiting_run" as const };
    const consuming = { ...waiting, id: "consuming-turn", deliveryState: "consuming" as const };
    const inbox = { items: [awaiting, consuming, waiting] };

    expect(writerPendingInbox(inbox)).toEqual({ items: [waiting] });
    expect(awaitingRunTurnIds(inbox)).toEqual(new Set(["awaiting-turn"]));
  });
});
