/** A branch room is reopened only for a review that still holds it. */
import { branchRoomName } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BranchRoomPool } from "./branch-room-pool";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BranchRoomPool.rebuild", () => {
  it("does not reopen a room whose last owner released while the retired session drained", async () => {
    const room = branchRoomName("draft-pool", 1);
    let finishDrain!: () => void;
    const draining = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    let resetListener: (snapshot: unknown) => void = () => {};
    let opened = 0;
    const pool = new BranchRoomPool({
      teardownGraceMs: 1,
      teardownOwner: new DocumentSessionTeardownOwner(() => new Error("unavailable")),
      openSession: () => {
        opened += 1;
        const first = opened === 1;
        return {
          getSnapshot: () => ({ connectionState: { kind: "reset", disposition: "rebuild" } }),
          resetDisposition: "rebuild",
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

    pool.retain("owner", [{ roomKey: room, currentRoom: async () => room, changed: () => {} }]);
    pool.get(room);
    resetListener({
      connectionState: { kind: "reset", reason: "branch-stale-doc", disposition: "rebuild" },
    });
    const rebuilt = pool.rebuild(room);
    const outcome = expect(rebuilt).rejects.toThrow("released");
    pool.release("owner");
    finishDrain();
    await outcome;

    await vi.advanceTimersByTimeAsync(10);
    expect(opened).toBe(1);
    expect(pool.peek(room)).toBeUndefined();
    pool.invalidate();
  });

  it("reopens the room for the owner that still holds it", async () => {
    const room = branchRoomName("draft-pool-held", 1);
    let resetListener: (snapshot: unknown) => void = () => {};
    let opened = 0;
    const pool = new BranchRoomPool({
      teardownGraceMs: 1,
      teardownOwner: new DocumentSessionTeardownOwner(() => new Error("unavailable")),
      openSession: () => {
        opened += 1;
        const first = opened === 1;
        return {
          getSnapshot: () => ({ connectionState: { kind: "reset", disposition: "rebuild" } }),
          resetDisposition: "rebuild",
          unacknowledgedUpdates: () => null,
          hasUnacknowledgedEdits: () => false,
          subscribe: (listener: (snapshot: unknown) => void) => {
            if (first) resetListener = listener;
            return () => {};
          },
          destroy: vi.fn(async () => {}),
        } as never;
      },
    });
    pool.retain("owner", [{ roomKey: room, currentRoom: async () => room, changed: () => {} }]);
    pool.get(room);
    resetListener({
      connectionState: { kind: "reset", reason: "branch-stale-doc", disposition: "rebuild" },
    });
    const fresh = await pool.rebuild(room);
    expect(opened).toBe(2);
    expect(pool.peek(room)).toBe(fresh);
    pool.invalidate();
  });
});

describe("BranchRoomPool.release", () => {
  it("never reopens a reset room for the owner that remains", async () => {
    const room = branchRoomName("draft-pool-two-owners", 1);
    let finishDrain!: () => void;
    const draining = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    let resetListener: (snapshot: unknown) => void = () => {};
    let opened = 0;
    const pool = new BranchRoomPool({
      teardownGraceMs: 1,
      teardownOwner: new DocumentSessionTeardownOwner(() => new Error("unavailable")),
      openSession: () => {
        opened += 1;
        const first = opened === 1;
        return {
          getSnapshot: () => ({ connectionState: { kind: "reset", disposition: "rebuild" } }),
          resetDisposition: "rebuild",
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
    pool.retain("editor", [{ roomKey: room, currentRoom: async () => room, changed: () => {} }]);
    pool.retain("refresh", [{ roomKey: room, currentRoom: async () => room, changed: () => {} }]);
    pool.get(room);
    resetListener({
      connectionState: { kind: "reset", reason: "branch-stale-doc", disposition: "rebuild" },
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
