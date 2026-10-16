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

type ControlledSession = {
  session: { destroy(): Promise<void> };
  destroy: ReturnType<typeof vi.fn>;
};

function controlledSession(): ControlledSession {
  const destroy = vi.fn<() => Promise<void>>();
  return { session: { destroy }, destroy };
}

const live = (roomKey = "doc") => ({ kind: "live" as const, roomKey });
const branch = (roomKey = "branch") => ({ kind: "branch" as const, roomKey });

describe("DocumentSessionTeardownOwner", () => {
  it("joins one retirement attempt, quarantines the room, then retries after rejection", async () => {
    const owner = new DocumentSessionTeardownOwner(() => new Error("room retiring"));
    const item = controlledSession();
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    item.destroy.mockImplementationOnce(() => first).mockResolvedValueOnce(undefined);

    const a = owner.retire(live(), item.session as never);
    const b = owner.retire(live(), item.session as never);
    expect(a).toBe(b);
    expect(() => owner.assertAvailable(live())).toThrow("room retiring");
    rejectFirst(new Error("transient destroy failure"));
    await expect(a).rejects.toThrow("transient destroy failure");

    await expect(owner.drain()).resolves.toBeUndefined();
    expect(item.destroy).toHaveBeenCalledTimes(2);
    expect(() => owner.assertAvailable(live())).not.toThrow();
    await expect(owner.retire(live(), item.session as never)).resolves.toBeUndefined();
    expect(item.destroy).toHaveBeenCalledTimes(2);
  });

  it("aggregates current failures and retries only retained sessions", async () => {
    const owner = new DocumentSessionTeardownOwner(() => new Error("retiring"));
    const a = controlledSession();
    const b = controlledSession();
    a.destroy.mockRejectedValueOnce(new Error("a")).mockResolvedValueOnce(undefined);
    b.destroy.mockRejectedValueOnce(new Error("b")).mockResolvedValueOnce(undefined);
    void owner.retire(live("a"), a.session as never).catch(() => undefined);
    void owner.retire(branch("b"), b.session as never).catch(() => undefined);

    await expect(owner.drain()).rejects.toBeInstanceOf(AggregateError);
    await expect(owner.drain()).resolves.toBeUndefined();
    expect(a.destroy).toHaveBeenCalledTimes(2);
    expect(b.destroy).toHaveBeenCalledTimes(2);
  });

  it("includes a session retired while a drain is awaiting", async () => {
    const owner = new DocumentSessionTeardownOwner(() => new Error("retiring"));
    const a = controlledSession();
    const b = controlledSession();
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    a.destroy.mockReturnValue(held);
    b.destroy.mockResolvedValue(undefined);
    void owner.retire(live("a"), a.session as never).catch(() => undefined);
    const draining = owner.drain();
    void owner.retire(branch("b"), b.session as never).catch(() => undefined);
    releaseHeld();

    await expect(draining).resolves.toBeUndefined();
    expect(b.destroy).toHaveBeenCalledOnce();
    expect(() => owner.assertAvailable(branch("b"))).not.toThrow();
  });
});
