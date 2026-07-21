import { act, type ReactNode, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

const setActiveEditorDocumentIdMock = vi.fn();
let rerenderHost: (() => void) | null = null;

/**
 * Mutable draft-review state the mocked provider reads at call time — lets a
 * single test flip between "no review" and "review active" without redefining
 * the module mock.
 */
const harness: {
  controller: {
    inlineReview: { documentId: string; draftId: string } | null;
    isDisposing: boolean;
  };
  reviewRoomName: string | null;
} = {
  controller: { inlineReview: null, isDisposing: false },
  reviewRoomName: null,
};

vi.mock("@/features/chat/DraftReviewProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/chat/DraftReviewProvider")>();
  return {
    ...actual,
    useDraftReview: () => ({
      controller: harness.controller,
      reviewRoomNameForDraft: () => harness.reviewRoomName,
      setActiveEditorDocumentId: setActiveEditorDocumentIdMock,
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
// review-chrome test asserts on.
vi.mock("@/features/editor/EditorView", () => ({
  EditorView: ({ belowToolbar }: { belowToolbar?: ReactNode }) => belowToolbar ?? null,
}));
vi.mock("@/features/editor/DraftReviewHeader", () => ({
  DraftReviewHeader: () => <section data-draft-review-header />,
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

beforeEach(() => {
  setActiveEditorDocumentIdMock.mockClear();
  harness.controller = { inlineReview: null, isDisposing: false };
  harness.reviewRoomName = null;
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

describe("ContextEditorMountHost draft chrome", () => {
  it("shows review header only during active inline review", async () => {
    await withReactRoot(<HostHarness />, async () => {
      // No review active → no chrome in the mount host (pending-draft chip
      // is now in the identity bar, not the editor banner slot).
      expectChrome("neither");

      harness.controller = {
        ...harness.controller,
        inlineReview: { documentId: "doc-1", draftId: "draft-1" },
      };
      await act(async () => rerenderHost?.());
      // Review selected but room not resolved yet → loading gap.
      expectChrome("neither");

      harness.reviewRoomName = "room-doc-1";
      await act(async () => rerenderHost?.());
      expectChrome("header");

      harness.controller = { ...harness.controller, inlineReview: null };
      harness.reviewRoomName = null;
      await act(async () => rerenderHost?.());
      expectChrome("neither");
    });
  });
});

function expectChrome(expected: "header" | "neither") {
  expect(Boolean(document.querySelector("[data-draft-review-header]"))).toBe(expected === "header");
}
