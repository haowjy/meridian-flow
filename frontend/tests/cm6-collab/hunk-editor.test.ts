import { describe, expect, it } from "vitest";
import {
  cancelHunkEditSession,
  commitHunkEditSession,
  resetHunkEditSession,
  startHunkEditSession,
  updateHunkEditSession,
} from "@/core/cm6-collab/review/hunk-editor";
import type { ReviewHunk } from "@/core/cm6-collab/review/types";

function hunk(overrides: Partial<ReviewHunk> = {}): ReviewHunk {
  return {
    id: "proposal-1-chunk-2",
    proposalId: "proposal-1",
    baseStart: 3,
    baseEnd: 6,
    deletedText: "foo",
    insertedText: "bar",
    status: "pending",
    ...overrides,
  };
}

describe("hunk editor session", () => {
  it("starts from the hunk's original inserted text", () => {
    const session = startHunkEditSession(hunk({ insertedText: "draft" }));

    expect(session).toEqual({
      proposalId: "proposal-1",
      hunkId: "proposal-1-chunk-2",
      originalInsertedText: "draft",
      draftInsertedText: "draft",
    });
  });

  it("updates, commits, and reports edited status", () => {
    const session = startHunkEditSession(hunk({ insertedText: "world" }));
    const nextSession = updateHunkEditSession(session, "planet");
    const commit = commitHunkEditSession(nextSession);

    expect(nextSession.draftInsertedText).toBe("planet");
    expect(commit).toEqual({
      proposalId: "proposal-1",
      hunkId: "proposal-1-chunk-2",
      originalInsertedText: "world",
      insertedText: "planet",
      wasEdited: true,
    });
  });

  it("supports reset and cancel helpers", () => {
    const session = startHunkEditSession(hunk({ insertedText: "world" }));
    const updated = updateHunkEditSession(session, "");
    const reset = resetHunkEditSession(updated);

    expect(reset.draftInsertedText).toBe("world");
    expect(cancelHunkEditSession()).toBeNull();
  });
});
