import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

const setActiveEditorDocumentIdMock = vi.fn();

/**
 * Mutable draft-review state the mocked provider reads at call time — lets a
 * single test flip between "pending draft, no review" and "review active"
 * without redefining the module mock.
 */
const harness: {
  controller: { inlineReview: { documentId: string; draftId: string } | null };
  reviewRoomName: string | null;
  group: ThreadDraftGroup | null;
} = {
  controller: { inlineReview: null },
  reviewRoomName: null,
  group: null,
};

const NOW = Date.parse("2026-07-07T12:00:00.000Z");

// importOriginal keeps reviewableDraftsFromGroup real: the mount host now
// derives its pending draft through docked-drafts.pendingReviewDraft, which
// calls into the real provider helper.
vi.mock("@/features/chat/DraftReviewProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/chat/DraftReviewProvider")>();
  return {
    ...actual,
    useDraftReview: () => ({
      controller: harness.controller,
      reviewRoomNameForDraft: () => harness.reviewRoomName,
      setActiveEditorDocumentId: setActiveEditorDocumentIdMock,
      groupForDocument: () => harness.group,
      nowMs: NOW,
    }),
  };
});
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    retain: vi.fn(),
    release: vi.fn(),
    get: vi.fn(() => ({ suspendPresence: vi.fn(), resumePresence: vi.fn() })),
  }),
}));
// EditorView paints the belowToolbar slot only — that slot is what the
// mutual-exclusion test asserts on.
vi.mock("@/features/editor/EditorView", () => ({
  EditorView: ({ belowToolbar }: { belowToolbar?: ReactNode }) => belowToolbar ?? null,
}));
vi.mock("@/features/editor/DraftReviewHeader", () => ({
  DraftReviewHeader: () => <section data-draft-review-header />,
}));
vi.mock("@/features/editor/DraftEntryBanner", () => ({
  DraftEntryBanner: () => <section data-draft-entry-banner />,
}));

const { ContextEditorMountHost } = await import("./ContextEditorMountHost");

const trackedTab: ContextTab = {
  documentId: "doc-1",
  scheme: "manuscript",
  path: "/chapter-1.md",
  name: "chapter-1.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

function pendingGroup(): ThreadDraftGroup {
  return {
    documentId: "doc-1",
    documentName: "chapter-1.md",
    contextPath: "work://drafts/doc-1.md",
    drafts: [
      {
        draftId: "draft-1",
        documentId: "doc-1",
        documentName: "chapter-1.md",
        contextPath: "work://drafts/doc-1.md",
        status: "active",
        lastActorTurnId: null,
        updatedAt: "2026-07-07T11:59:00.000Z",
        appliedAt: null,
        discardedAt: null,
        proposedOperationCount: 2,
        wordsAdded: null,
        wordsRemoved: null,
      },
    ],
  };
}

beforeEach(() => {
  setActiveEditorDocumentIdMock.mockClear();
  harness.controller = { inlineReview: null };
  harness.reviewRoomName = null;
  harness.group = null;
});

describe("ContextEditorMountHost active editor wiring", () => {
  it("reports the active tracked tab id even when the context route is inactive", async () => {
    await withReactRoot(
      <ContextEditorMountHost
        projectId="project-1"
        trackedTabs={[trackedTab]}
        activeTabId="doc-1"
        active={false}
      />,
      () => {
        expect(setActiveEditorDocumentIdMock).toHaveBeenCalledWith("doc-1");
      },
    );
  });
});

describe("ContextEditorMountHost draft chrome exclusion", () => {
  it("renders the entry banner (not the review header) when the active doc has a pending draft and review is closed", async () => {
    harness.group = pendingGroup();
    await withReactRoot(
      <ContextEditorMountHost
        projectId="project-1"
        trackedTabs={[trackedTab]}
        activeTabId="doc-1"
        active={true}
      />,
      () => {
        expect(document.querySelector("[data-draft-entry-banner]")).not.toBeNull();
        expect(document.querySelector("[data-draft-review-header]")).toBeNull();
      },
    );
  });

  it("renders the review header (not the entry banner) when review is active", async () => {
    harness.controller = { inlineReview: { documentId: "doc-1", draftId: "draft-1" } };
    harness.reviewRoomName = "room-doc-1";
    // A pending group still exists, but review takes the slot — the two are
    // mutually exclusive by construction.
    harness.group = pendingGroup();
    await withReactRoot(
      <ContextEditorMountHost
        projectId="project-1"
        trackedTabs={[trackedTab]}
        activeTabId="doc-1"
        active={true}
      />,
      () => {
        expect(document.querySelector("[data-draft-review-header]")).not.toBeNull();
        expect(document.querySelector("[data-draft-entry-banner]")).toBeNull();
      },
    );
  });
});
