/** Tests for presence-derived draft review leases. */
import { describe, expect, it } from "vitest";
import { createDraftReviewLease } from "./draft-review-lease.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";

describe("createDraftReviewLease", () => {
  it("marks a draft under review while a draft-room writer connection is open", () => {
    const lease = createDraftReviewLease();

    lease.enter({ draftId: "draft-1", socketId: "socket-1", userId: USER_ID });

    expect(lease.isUnderReview("draft-1")).toBe(true);
    expect(lease.connectedCount("draft-1")).toBe(1);
  });

  it("keeps the lease through the last-disconnect grace and releases after it elapses", () => {
    const scheduled: Array<() => void> = [];
    const lease = createDraftReviewLease({
      graceMs: 30_000,
      setTimer(fn) {
        scheduled.push(fn);
        return scheduled.length;
      },
      clearTimer() {},
    });

    lease.enter({ draftId: "draft-1", socketId: "socket-1", userId: USER_ID });
    lease.leave({ draftId: "draft-1", socketId: "socket-1" });

    expect(lease.connectedCount("draft-1")).toBe(0);
    expect(lease.isUnderReview("draft-1")).toBe(true);

    scheduled[0]?.();

    expect(lease.isUnderReview("draft-1")).toBe(false);
  });

  it("cancels the pending release when a writer reconnects during grace", () => {
    const scheduled: Array<() => void> = [];
    const cleared: unknown[] = [];
    const lease = createDraftReviewLease({
      setTimer(fn) {
        scheduled.push(fn);
        return scheduled.length;
      },
      clearTimer(timer) {
        cleared.push(timer);
      },
    });

    lease.enter({ draftId: "draft-1", socketId: "socket-1", userId: USER_ID });
    lease.leave({ draftId: "draft-1", socketId: "socket-1" });
    lease.enter({ draftId: "draft-1", socketId: "socket-2", userId: USER_ID });

    expect(cleared).toEqual([1]);
    scheduled[0]?.();

    expect(lease.isUnderReview("draft-1")).toBe(true);
    expect(lease.connectedCount("draft-1")).toBe(1);
  });
});
