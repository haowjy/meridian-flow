import { DRAFT_UNDO_RETENTION_MS, type ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { isDraftUndoable } from "./draft-undoable";

function draft(input: Partial<ThreadDraftListItem>): ThreadDraftListItem {
  return {
    draftId: "draft-1",
    documentId: "doc-1",
    documentName: "Chapter 1",
    contextPath: "/Chapter 1.md",
    status: "applied",
    lastActorTurnId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    appliedAt: "2026-01-01T00:00:00.000Z",
    discardedAt: null,
    ...input,
  };
}

describe("isDraftUndoable", () => {
  const nowMs = Date.parse("2026-01-02T00:00:00.000Z");

  it("never treats active drafts as undoable", () => {
    expect(
      isDraftUndoable(draft({ status: "active", appliedAt: new Date(nowMs).toISOString() }), nowMs),
    ).toBe(false);
  });

  it("keeps terminal drafts undoable at the retention boundary", () => {
    expect(
      isDraftUndoable(
        draft({
          appliedAt: new Date(nowMs - DRAFT_UNDO_RETENTION_MS).toISOString(),
          updatedAt: new Date(nowMs).toISOString(),
        }),
        nowMs,
      ),
    ).toBe(true);
  });

  it("expires terminal drafts just past the retention boundary", () => {
    expect(
      isDraftUndoable(
        draft({
          appliedAt: new Date(nowMs - DRAFT_UNDO_RETENTION_MS - 1).toISOString(),
          updatedAt: new Date(nowMs).toISOString(),
        }),
        nowMs,
      ),
    ).toBe(false);
  });

  it("uses discardedAt for discarded drafts", () => {
    expect(
      isDraftUndoable(
        draft({
          status: "discarded",
          appliedAt: null,
          discardedAt: new Date(nowMs - DRAFT_UNDO_RETENTION_MS).toISOString(),
          updatedAt: new Date(nowMs - DRAFT_UNDO_RETENTION_MS - 1).toISOString(),
        }),
        nowMs,
      ),
    ).toBe(true);
  });

  it("does not render undo for invalid timestamps", () => {
    expect(isDraftUndoable(draft({ appliedAt: "not-a-date" }), nowMs)).toBe(false);
  });
});
