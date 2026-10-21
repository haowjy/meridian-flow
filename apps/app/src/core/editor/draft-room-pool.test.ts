/** A draft room is reopened only for a review that still holds it. */
import { draftRoomName } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";
import { DraftRoomPool } from "./draft-room-pool";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("DraftRoomPool.release", () => {
  it("never reopens a closed room for the owner that remains", async () => {
    const room = draftRoomName("draft-pool-two-owners");
    let finishDrain!: () => void;
    const draining = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    let resetListener: (snapshot: unknown) => void = () => {};
    let opened = 0;
    const pool = new DraftRoomPool({
      teardownGraceMs: 1,
      teardownOwner: new DocumentSessionTeardownOwner(() => new Error("unavailable")),
      openSession: () => {
        opened += 1;
        const first = opened === 1;
        return {
          getSnapshot: () => ({ connectionState: { kind: "reset", disposition: "removed" } }),
          resetDisposition: "removed",
          unacknowledgedUpdates: () => null,
          hasUnacknowledgedEdits: () => false,
          subscribe: (listener: (snapshot: unknown) => void) => {
            if (first) resetListener = listener;
            return () => {};
          },
          destroy: first ? () => draining : vi.fn(async () => {}),
        } as never;
      },
    });
    pool.retain("editor", [room]);
    pool.retain("refresh", [room]);
    pool.get(room);
    resetListener({
      connectionState: { kind: "reset", reason: "discarded", disposition: "removed" },
    });

    // The room is retiring and the refresh owner still retains it.
    expect(() => pool.release("editor")).not.toThrow();
    finishDrain();
    await vi.advanceTimersByTimeAsync(0);
    pool.release("refresh");
    expect(opened).toBe(1);
    expect(pool.peek(room)).toBeUndefined();
    pool.invalidate();
  });
});
