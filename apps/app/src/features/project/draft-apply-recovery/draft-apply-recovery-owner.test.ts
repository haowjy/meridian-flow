import { describe, expect, it, vi } from "vitest";
import {
  AccountPostApplyDispositionOwner,
  type ApplyDispatchGrant,
  type DraftRecoveryIdentity,
  type DraftRecoveryObligations,
} from "./draft-apply-recovery-owner";

const identity: DraftRecoveryIdentity = {
  accountId: "account-a",
  projectId: "project-a",
  workId: "work-a",
  documentId: "document-a",
  draftId: "draft-a",
};
const obligations: DraftRecoveryObligations = {
  draftTab: {
    kind: "draft-only",
    reviewWorkId: "work-a",
    reviewDraftId: "draft-a",
    tabInstanceToken: "tab-a",
  },
  branch: { kind: "generation-qualified", reviewRoomName: "branch-a" },
};
const presentation = { documentName: "Chapter", contextPath: "chapter.md", owningWorkLabel: null };

function harness() {
  const replaceExactRoomNames = vi.fn();
  return {
    owner: new AccountPostApplyDispositionOwner("account-a", { replaceExactRoomNames }),
    replaceExactRoomNames,
  };
}

function dispatch(owner: AccountPostApplyDispositionOwner): ApplyDispatchGrant {
  const reserved = owner.reserveApply({ identity, presentation, obligations });
  if (reserved.kind !== "reserved") throw new Error("reservation failed");
  const acquired = owner.acquireApplyDispatch(reserved.unsent);
  if (acquired.kind !== "dispatch-granted") throw new Error("dispatch failed");
  return acquired.dispatch;
}

describe("AccountPostApplyDispositionOwner", () => {
  it("retains the branch before granting a single typed dispatch", () => {
    const { owner, replaceExactRoomNames } = harness();
    const first = owner.reserveApply({ identity, presentation, obligations });
    expect(first.kind).toBe("reserved");
    expect(replaceExactRoomNames).toHaveBeenNthCalledWith(1, ["branch-a"]);
    expect(owner.reserveApply({ identity, presentation, obligations })).toEqual({
      kind: "blocked",
    });
    if (first.kind !== "reserved") return;
    expect(owner.acquireApplyDispatch(first.unsent).kind).toBe("dispatch-granted");
    expect(owner.acquireApplyDispatch(first.unsent)).toEqual({ kind: "stale" });
    expect(owner.releaseUnsentReservation(first.unsent)).toBe(false);
  });

  it("joins delayed positive and ambiguous completions without a duplicate item or unknown", () => {
    const { owner } = harness();
    const granted = dispatch(owner);
    const promoted = owner.recordServerApplied({
      kind: "local-response",
      dispatch: granted,
      responseDraftId: "draft-a",
    });
    expect(promoted.kind).toBe("recorded");
    expect(owner.markApplyOutcomeUnknown(granted)).toMatchObject({ kind: "existing" });
    expect(
      owner.recordServerApplied({
        kind: "local-response",
        dispatch: granted,
        responseDraftId: "draft-a",
      }),
    ).toMatchObject({ kind: "existing" });
    expect(owner.getSnapshot()).toMatchObject({
      reservations: [],
      items: [{ entryVersion: 2, phase: { kind: "queued", attemptVersion: 1 } }],
      appliedSuppressions: [{ committedVersion: 2, terminalDisposition: null }],
    });
  });

  it("fences exact-active uncertainty checks by reservation and check version", () => {
    const { owner } = harness();
    const granted = dispatch(owner);
    const unknown = owner.markApplyOutcomeUnknown(granted);
    if (unknown.kind !== "outcome-unknown") throw new Error("unknown transition failed");
    const checkOne = owner.beginApplyOutcomeCheck(unknown.reservation);
    const checkTwo = owner.beginApplyOutcomeCheck(unknown.reservation);
    if (!checkOne || !checkTwo) throw new Error("check transition failed");
    const activeDrafts = [{ identity, presentation, obligations }];
    owner.reconcileForcedDraftList({
      accountId: "account-a",
      projectId: "project-a",
      workId: "work-a",
      activeDrafts,
      outcomeCheck: checkOne,
    });
    expect(owner.getSnapshot().reservations).toHaveLength(1);
    owner.reconcileForcedDraftList({
      accountId: "account-a",
      projectId: "project-a",
      workId: "work-a",
      activeDrafts,
      outcomeCheck: checkTwo,
    });
    expect(owner.getSnapshot().reservations).toHaveLength(0);
  });

  it("records the terminal outcome before removing the item and joins stale callers truthfully", () => {
    const { owner, replaceExactRoomNames } = harness();
    const granted = dispatch(owner);
    const promoted = owner.recordServerApplied({
      kind: "local-response",
      dispatch: granted,
      responseDraftId: "draft-a",
    });
    if (promoted.kind !== "recorded") throw new Error("promotion failed");
    const attempt = owner.beginAttempt(promoted.recovery);
    if (!attempt) throw new Error("attempt failed");
    const disposition = owner.beginLiveSettlement(attempt);
    if (!disposition) throw new Error("settlement failed");
    expect(owner.completeDisposition(disposition)).toBe(false);
    owner.recordDispositionEffect({ disposition, effect: "context" });
    expect(owner.completeDisposition(disposition)).toBe(true);
    expect(owner.getSnapshot().items).toEqual([]);
    expect(owner.reserveApply({ identity, presentation, obligations })).toEqual({
      kind: "settled",
      outcome: "live-ready",
    });
    expect(replaceExactRoomNames).toHaveBeenLastCalledWith([]);
  });

  it("keeps snapshots JSON data-only", () => {
    const { owner } = harness();
    dispatch(owner);
    const snapshot = owner.getSnapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toMatch(/AbortController|Promise|session|binding|lease/);
  });
});
