import { act, type ReactNode, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

const setActiveEditorDocumentIdMock = vi.fn();
const openAiDraftMock = vi.fn();
let rerenderHost: (() => void) | null = null;

/**
 * Mutable draft-review state the mocked provider reads at call time — lets a
 * single test flip between "pending draft, no review" and "review active"
 * without redefining the module mock.
 */
const harness: {
  controller: {
    inlineReview: { documentId: string; draftId: string } | null;
    isDisposing: boolean;
  };
  reviewRoomName: string | null;
  group: ThreadDraftGroup | null;
} = {
  controller: { inlineReview: null, isDisposing: false },
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
vi.mock("@/features/chat/useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: openAiDraftMock }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const { ContextEditorMountHost } = await import("./ContextEditorMountHost");

const trackedTab: Extract<ContextTab, { editable: true }> = {
  kind: "tracked",
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
        isNewDocument: true,
        wordsAdded: null,
        wordsRemoved: null,
      },
    ],
  };
}

beforeEach(() => {
  setActiveEditorDocumentIdMock.mockClear();
  openAiDraftMock.mockClear();
  harness.controller = { inlineReview: null, isDisposing: false };
  harness.reviewRoomName = null;
  harness.group = null;
});

function HostHarness({ active = true }: { active?: boolean }) {
  const [, setRevision] = useState(0);
  useEffect(() => {
    rerenderHost = () => setRevision((revision) => revision + 1);
    return () => {
      rerenderHost = null;
    };
  }, []);
  return (
    <ContextEditorMountHost
      projectId="project-1"
      trackedTabs={[trackedTab]}
      activeTabId="doc-1"
      active={active}
    />
  );
}

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
  it("keeps banner and review chrome exclusive across a live-review-live transition", async () => {
    harness.group = pendingGroup();
    await withReactRoot(<HostHarness />, async () => {
      expectChrome("banner");

      harness.controller = {
        ...harness.controller,
        inlineReview: { documentId: "doc-1", draftId: "draft-1" },
      };
      await act(async () => rerenderHost?.());
      expectChrome("neither");

      harness.reviewRoomName = "room-doc-1";
      await act(async () => rerenderHost?.());
      expectChrome("header");

      harness.controller = { ...harness.controller, inlineReview: null };
      harness.reviewRoomName = null;
      await act(async () => rerenderHost?.());
      expectChrome("banner");

      document.querySelector<HTMLButtonElement>("[data-draft-entry-banner] button")?.click();
      expect(openAiDraftMock).toHaveBeenCalledWith(
        {
          documentId: "doc-1",
          contextPath: "work://drafts/doc-1.md",
          documentName: "chapter-1.md",
          isNewDocument: true,
        },
        "draft-1",
      );
    });
  });

  it("does not mount the live-region banner while the context surface is inactive", async () => {
    harness.group = pendingGroup();
    await withReactRoot(<HostHarness active={false} />, () => expectChrome("neither"));
  });
});

function expectChrome(expected: "banner" | "header" | "neither") {
  expect(Boolean(document.querySelector("[data-draft-entry-banner]"))).toBe(expected === "banner");
  expect(Boolean(document.querySelector("[data-draft-review-header]"))).toBe(expected === "header");
}
