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
    ...input,
  };
}

describe("isDraftUndoable", () => {
  const nowMs = Date.parse("2026-01-02T00:00:00.000Z");

  it("never treats active drafts as undoable", () => {
    expect(
      isDraftUndoable(draft({ status: "active", updatedAt: new Date(nowMs).toISOString() }), nowMs),
    ).toBe(false);
  });

  it("keeps terminal drafts undoable at the retention boundary", () => {
    expect(
      isDraftUndoable(
        draft({ updatedAt: new Date(nowMs - DRAFT_UNDO_RETENTION_MS).toISOString() }),
        nowMs,
      ),
    ).toBe(true);
  });

  it("expires terminal drafts just past the retention boundary", () => {
    expect(
      isDraftUndoable(
        draft({ updatedAt: new Date(nowMs - DRAFT_UNDO_RETENTION_MS - 1).toISOString() }),
        nowMs,
      ),
    ).toBe(false);
  });

  it("does not render undo for invalid timestamps", () => {
    expect(isDraftUndoable(draft({ updatedAt: "not-a-date" }), nowMs)).toBe(false);
  });
});
