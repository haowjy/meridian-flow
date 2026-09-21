/**
 * The pending tray reads the wire-shaped inbox and only from the
 * `meridian.inbox.changed` frame; unrelated or malformed frames are ignored.
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  EMPTY_THREAD_PENDING_INBOX,
  isThreadPendingInbox,
  pendingInboxFromEvent,
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
