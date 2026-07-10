/**
 * pendingReviewDraft — THE per-document pending-changes signal shared by the
 * dock's pending rows and the editor's DraftEntryBanner. It resolves to the
 * newest active draft that actually carries review content, or null.
 */

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import {
  activeDockedDraftGroups,
  dockRows,
  pendingDockedDraftCount,
  pendingReviewDraft,
} from "./docked-drafts";

const NOW = Date.parse("2026-07-07T12:00:00.000Z");

function draft(overrides: Partial<ThreadDraftListItem>): ThreadDraftListItem {
  return {
    draftId: "draft-1",
    documentId: "doc-1",
    documentName: "doc-1",
    contextPath: "work://drafts/doc-1.md",
    status: "active",
    lastActorTurnId: null,
    updatedAt: "2026-07-07T11:59:00.000Z",
    appliedAt: null,
    discardedAt: null,
    wordsAdded: null,
    wordsRemoved: null,
    ...overrides,
  };
}

function group(drafts: ThreadDraftListItem[]): ThreadDraftGroup {
  return {
    documentId: "doc-1",
    documentName: "doc-1",
    contextPath: "work://drafts/doc-1.md",
    drafts,
  };
}

describe("pendingReviewDraft", () => {
  it("returns the active draft that carries review content", () => {
    const active = draft({ proposedOperationCount: 3 });
    expect(pendingReviewDraft(group([active]), NOW)).toBe(active);
  });

  it("is the same draft used by the dock's pending row", () => {
    const pending = draft({ draftId: "pending", proposedOperationCount: 3 });
    const contentless = draft({
      draftId: "contentless",
      proposedOperationCount: 0,
      wordsAdded: 0,
      wordsRemoved: 0,
    });
    const drafts = group([contentless, pending]);

    const pendingRow = dockRows([drafts], NOW).find((row) => row.state === "pending");
    expect(pendingRow?.draft).toBe(pendingReviewDraft(drafts, NOW));
  });

  it("returns null when the active draft has no review content", () => {
    const contentless = draft({
      proposedOperationCount: 0,
      wordsAdded: 0,
      wordsRemoved: 0,
    });
    expect(pendingReviewDraft(group([contentless]), NOW)).toBeNull();
  });

  it("returns null when the group has no active draft", () => {
    const closed = draft({
      status: "closed",
      appliedAt: "2026-07-07T11:00:00.000Z",
    });
    expect(pendingReviewDraft(group([closed]), NOW)).toBeNull();
  });

  it("returns null for a null group", () => {
    expect(pendingReviewDraft(null, NOW)).toBeNull();
  });
});

describe("pendingDockedDraftCount", () => {
  it("counts contentful active groups and excludes contentless active groups", () => {
    const visible = group([draft({ proposedOperationCount: 2 })]);
    const contentless = {
      ...group([draft({ proposedOperationCount: 0, wordsAdded: 0, wordsRemoved: 0 })]),
      documentId: "doc-2",
    };

    expect(pendingDockedDraftCount([visible, contentless])).toBe(1);
  });

  it("returns zero for unknown groups because the mode switch stays disabled while they load", () => {
    expect(pendingDockedDraftCount(null)).toBe(0);
  });
});

describe("activeDockedDraftGroups", () => {
  it("omits a contentless active draft", () => {
    const contentless = group([
      draft({ proposedOperationCount: 0, wordsAdded: 0, wordsRemoved: 0 }),
    ]);

    expect(activeDockedDraftGroups([contentless])).toEqual([]);
  });

  it("retains a contentful active draft", () => {
    const contentful = group([draft({ proposedOperationCount: 1 })]);

    expect(activeDockedDraftGroups([contentful])).toEqual([contentful]);
  });

  it("returns no active groups while the query result is unknown", () => {
    expect(activeDockedDraftGroups(null)).toEqual([]);
  });
});
