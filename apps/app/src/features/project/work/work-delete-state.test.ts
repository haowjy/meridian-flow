import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import { emptyWorkDeleteState, workDeleteTransition } from "./work-delete-state";

const work = { id: "work-a", name: "Revise arc 3" } as Work;

describe("Work delete collection state", () => {
  it("optimistically hides a deleted Work and exposes it for Undo", () => {
    expect(workDeleteTransition(emptyWorkDeleteState(), { type: "delete", work })).toEqual({
      deleted: work,
      failed: null,
      restorePending: false,
    });
  });

  it("restores a failed delete to the list with retry available", () => {
    const deleting = workDeleteTransition(emptyWorkDeleteState(), { type: "delete", work });
    expect(workDeleteTransition(deleting, { type: "delete-failed" })).toEqual({
      deleted: null,
      failed: work,
      restorePending: false,
    });
    expect(
      workDeleteTransition(workDeleteTransition(deleting, { type: "delete-failed" }), {
        type: "retry",
      }),
    ).toEqual(deleting);
  });

  it("keeps the optimistic re-insert on failed Undo and clears after success/dismissal", () => {
    const deleting = workDeleteTransition(emptyWorkDeleteState(), { type: "delete", work });
    const undoing = workDeleteTransition(deleting, { type: "undo" });
    expect(undoing.restorePending).toBe(true);
    expect(workDeleteTransition(undoing, { type: "restore-failed" }).deleted).toBe(work);
    expect(workDeleteTransition(undoing, { type: "dismiss" })).toEqual(emptyWorkDeleteState());
  });
});
