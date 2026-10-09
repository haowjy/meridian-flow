/** A branch room is reopened only for a review that still holds it. */
import { branchRoomName } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import { BranchRoomPool } from "./branch-room-pool";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";

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
          subscribe: (listener: (snapshot: unknown) => void) => {
            if (first) resetListener = listener;
            return () => {};
          },
          destroy: first ? () => draining : vi.fn(async () => {}),
        } as never;
      },
    });

    pool.retain("owner", [room]);
    pool.get(room);
    resetListener({ connectionState: { kind: "reset" } });
    const rebuilt = pool.rebuild(room);
    const outcome = expect(rebuilt).rejects.toThrow("released");
    pool.release("owner");
    finishDrain();
    await outcome;

    await new Promise((resolve) => setTimeout(resolve, 10));
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
          subscribe: (listener: (snapshot: unknown) => void) => {
            if (first) resetListener = listener;
            return () => {};
          },
          destroy: vi.fn(async () => {}),
        } as never;
      },
    });
    pool.retain("owner", [room]);
    pool.get(room);
    resetListener({ connectionState: { kind: "reset" } });
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
    resetListener({ connectionState: { kind: "reset" } });

    // The room is retiring and the refresh owner still retains it.
    expect(() => pool.release("editor")).not.toThrow();
    finishDrain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    pool.release("refresh");
    expect(opened).toBe(1);
    expect(pool.peek(room)).toBeUndefined();
    pool.invalidate();
  });
});
