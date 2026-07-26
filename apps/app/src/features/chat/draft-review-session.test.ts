/** Contract for the synchronous, session-wide draft disposition lock. */
import { describe, expect, it, vi } from "vitest";
import {
  DraftDispositionLock,
  type DraftReviewCommandPorts,
  DraftReviewSession,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  inlineReviewFromState,
} from "./draft-review-session";

describe("DraftReviewSession", () => {
  it("applies the whole branch without acquiring operation-scoped evidence", async () => {
    const ports = commandPorts();
    const session = new DraftReviewSession(() => ports);
    const reviewed = {
      documentId: "document-1",
      draftId: "draft-1",
      operationIds: ["reviewed-operation"],
      draftRevisionToken: 1,
      branchId: "branch-1",
    };

    await expect(
      session.applyReviewedDraft(
        { documentId: reviewed.documentId, draftId: reviewed.draftId },
        reviewed,
      ),
    ).resolves.toEqual({ kind: "applied" });
    expect(ports.loadPreview).not.toHaveBeenCalled();
    expect(ports.apply).toHaveBeenLastCalledWith(
      { documentId: "document-1", draftId: "draft-1" },
      "draft",
      {
        draftId: "draft-1",
        branchId: "branch-1",
      },
    );

    await expect(
      session.disposeDrafts("apply", [
        { documentId: "document-1", draftId: "draft-1" },
        { documentId: "document-2", draftId: "draft-2" },
      ]),
    ).resolves.toEqual([{ kind: "applied" }, { kind: "applied" }]);
    expect(ports.loadPreview).not.toHaveBeenCalled();
    expect(ports.apply).toHaveBeenCalledTimes(3);
  });
});

describe("DraftDispositionLock", () => {
  it("reserves synchronously before acquisition and rejects every overlapping command", () => {
    const lock = new DraftDispositionLock();
    const first = lock.reserve({
      kind: "apply-operation",
      documentId: "document-1",
      draftId: "draft-1",
      operationId: "operation-1",
    });

    expect(first).not.toBeNull();
    expect(lock.getSnapshot()).toMatchObject({
      phase: "acquiring",
      target: { kind: "apply-operation", operationId: "operation-1" },
    });
    expect(
      lock.reserve({
        kind: "discard-draft",
        documentId: "document-2",
        draftId: "draft-2",
      }),
    ).toBeNull();
  });

  it("only lets the reservation owner advance and release the lock", () => {
    const lock = new DraftDispositionLock();
    const first = lock.reserve({
      kind: "discard-operation",
      documentId: "document-1",
      draftId: "draft-1",
      operationId: "operation-1",
    });
    const other = Symbol("other");
    if (!first) throw new Error("reservation failed");

    expect(lock.advance(other, "mutating")).toBe(false);
    expect(lock.release(other)).toBe(false);
    expect(lock.advance(first, "settling")).toBe(true);
    expect(lock.getSnapshot().phase).toBe("settling");
    expect(lock.release(first)).toBe(true);
    expect(lock.getSnapshot()).toEqual({ phase: "idle" });
  });
});

describe("draft review derived identity", () => {
  it.each([
    {
      action: {
        type: "applySucceeded" as const,
        documentId: "document-1",
        draftId: "draft-1",
        outcome: {
          command: { kind: "applied" as const },
          message: null,
          refreshDraftId: null,
          materializedDocument: false,
        },
      },
    },
    {
      action: {
        type: "rejectSucceeded" as const,
        draftId: "draft-1",
      },
    },
  ])("exits review after the active draft reaches a terminal disposition", ({ action }) => {
    const entered = draftReviewReducer(EMPTY_DRAFT_REVIEW_STATE, {
      type: "enterInline",
      documentId: "document-1",
      draftId: "draft-1",
    });

    expect(inlineReviewFromState(draftReviewReducer(entered, action))).toBeNull();
  });

  it("preserves state and selection identity when the same preview reports twice", () => {
    const entered = draftReviewReducer(EMPTY_DRAFT_REVIEW_STATE, {
      type: "enterInline",
      documentId: "document-1",
      draftId: "draft-1",
    });
    const loaded = draftReviewReducer(entered, {
      type: "inlineModelAvailable",
      documentId: "document-1",
      draftId: "draft-1",
      identity: "preview-1",
    });
    const selection = inlineReviewFromState(loaded);
    const repeated = draftReviewReducer(loaded, {
      type: "inlineModelAvailable",
      documentId: "document-1",
      draftId: "draft-1",
      identity: "preview-1",
    });

    expect(repeated).toBe(loaded);
    expect(inlineReviewFromState(repeated)).toBe(selection);
  });
});

function commandPorts(): DraftReviewCommandPorts {
  return {
    loadPreview: vi.fn(async ({ documentId, draftId }) => ({
      documentId,
      draftId,
      operationIds: [`operation-${draftId}`],
      draftRevisionToken: 2,
      branchId: `branch-${draftId}`,
    })),
    apply: vi.fn(async ({ draftId }) => ({ status: "applied" as const, draftId })),
    discard: vi.fn(async () => {}),
    operationApplyStarted: vi.fn(),
    operationDiscardStarted: vi.fn(),
    batchStarted: vi.fn(),
    batchSettled: vi.fn(),
    applySettled: vi.fn(),
    draftFailed: vi.fn(),
    draftDiscarded: vi.fn(),
  };
}
